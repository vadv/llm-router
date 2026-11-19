// Owner-scoped temporary source ids. A search result URL becomes a random
// id; read_source accepts only an id of the same owner, never a raw URL.
// RAM only: no SQLite table, no persistent search history. A restart makes
// old ids unknown, which callers see as a plain not-found.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Injectable clock so TTL tests stay deterministic.
pub trait Clock: Send + Sync {
    fn now(&self) -> Instant;
}

impl<T: Clock + ?Sized> Clock for Arc<T> {
    fn now(&self) -> Instant {
        (**self).now()
    }
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Instant {
        Instant::now()
    }
}

/// Manual test clock; clones share the same time.
#[cfg(test)]
#[derive(Clone)]
pub struct FakeClock {
    now: Arc<Mutex<Instant>>,
}

#[cfg(test)]
impl Default for FakeClock {
    fn default() -> Self {
        Self {
            now: Arc::new(Mutex::new(Instant::now())),
        }
    }
}

#[cfg(test)]
impl FakeClock {
    pub fn advance(&self, by: Duration) {
        let mut now = self.now.lock().unwrap();
        *now = now.checked_add(by).unwrap_or(*now);
    }
}

#[cfg(test)]
impl Clock for FakeClock {
    fn now(&self) -> Instant {
        *self.now.lock().unwrap()
    }
}

#[derive(Debug, Clone, Copy)]
pub struct SourceRegistryConfig {
    pub max_ids_per_owner: usize,
    pub ttl: Duration,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegisteredSource {
    pub url: String,
    pub provider: crate::web_search::Provider,
    created_at: Instant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LookupError {
    NotFound,
    Expired,
}

#[derive(Default)]
struct OwnerSources {
    /// Insertion order = age order; eviction removes from the front.
    entries: Vec<(String, RegisteredSource)>,
}

impl OwnerSources {
    /// Drop entries older than the ttl; the registry is cleaned on access.
    fn prune(&mut self, now: Instant, ttl: Duration) {
        self.entries
            .retain(|(_, source)| now.duration_since(source.created_at) < ttl);
    }
}

pub struct SourceRegistry {
    config: SourceRegistryConfig,
    clock: Box<dyn Clock>,
    owners: Mutex<HashMap<String, OwnerSources>>,
}

impl SourceRegistry {
    pub fn new(config: SourceRegistryConfig) -> Self {
        Self::with_clock(config, SystemClock)
    }

    pub fn with_clock(config: SourceRegistryConfig, clock: impl Clock + 'static) -> Self {
        Self {
            config,
            clock: Box::new(clock),
            owners: Mutex::new(HashMap::new()),
        }
    }

    /// Register one URL for one owner and hand out its fresh id. The owner's
    /// list is pruned of expired entries first; beyond the cap the oldest
    /// entries are evicted. The lock is held for the list edit only, never
    /// across a network await.
    pub fn register(
        &self,
        owner: &str,
        url: &str,
        provider: crate::web_search::Provider,
    ) -> String {
        let id = new_source_id();
        let now = self.clock.now();
        let mut owners = self.owners.lock().unwrap();
        let list = owners.entry(owner.to_owned()).or_default();
        list.prune(now, self.config.ttl);
        while list.entries.len() >= self.config.max_ids_per_owner {
            list.entries.remove(0);
        }
        list.entries.push((
            id.clone(),
            RegisteredSource {
                url: url.to_owned(),
                provider,
                created_at: now,
            },
        ));
        id
    }

    /// Resolve an id for its owner. Expired entries are removed and reported
    /// as expired; ids of other owners are plain not-found.
    pub fn lookup(&self, owner: &str, source_id: &str) -> Result<RegisteredSource, LookupError> {
        let now = self.clock.now();
        let mut owners = self.owners.lock().unwrap();
        let Some(list) = owners.get_mut(owner) else {
            return Err(LookupError::NotFound);
        };
        let Some(index) = list.entries.iter().position(|(id, _)| id == source_id) else {
            // Cleanup on access covers the entries that were not asked for.
            list.prune(now, self.config.ttl);
            return Err(LookupError::NotFound);
        };
        if now.duration_since(list.entries[index].1.created_at) >= self.config.ttl {
            list.entries.remove(index);
            return Err(LookupError::Expired);
        }
        list.prune(now, self.config.ttl);
        Ok(list.entries[index].1.clone())
    }
}

/// One 64-bit draw of OS entropy without a random crate: a freshly seeded
/// SipHash finish is a function of its random key only.
fn random_u64() -> u64 {
    use std::hash::{BuildHasher, Hasher};
    std::collections::hash_map::RandomState::new()
        .build_hasher()
        .finish()
}

/// A fresh unguessable id. Cross-owner guessing is stopped by owner scoping,
/// not id entropy; unguessable ids additionally avoid leaking how much one
/// owner has searched.
fn new_source_id() -> String {
    format!("{:016x}{:016x}", random_u64(), random_u64())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::web_search::Provider;

    const TTL: Duration = Duration::from_secs(60);

    fn registry(max: usize) -> (SourceRegistry, FakeClock) {
        let clock = FakeClock::default();
        (
            SourceRegistry::with_clock(
                SourceRegistryConfig {
                    max_ids_per_owner: max,
                    ttl: TTL,
                },
                clock.clone(),
            ),
            clock,
        )
    }

    fn register(registry: &SourceRegistry, owner: &str, n: usize) -> Vec<String> {
        (0..n)
            .map(|i| {
                registry.register(
                    owner,
                    &format!("https://example.com/{i}"),
                    Provider::Deepseek,
                )
            })
            .collect()
    }

    #[test]
    fn register_then_lookup_round_trips() {
        let (registry, _) = registry(10);
        let id = registry.register("laptop", "https://example.com/a", Provider::Zai);
        let source = registry.lookup("laptop", &id).unwrap();
        assert_eq!(source.url, "https://example.com/a");
        assert_eq!(source.provider, Provider::Zai);
    }

    #[test]
    fn ids_are_unique() {
        let (registry, _) = registry(10);
        let ids = register(&registry, "laptop", 50);
        let mut sorted = ids.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), ids.len());
    }

    #[test]
    fn other_owners_and_unknown_ids_are_not_found() {
        let (registry, _) = registry(10);
        let ids = register(&registry, "laptop", 1);
        assert_eq!(
            registry.lookup("phone", &ids[0]),
            Err(LookupError::NotFound)
        );
        assert_eq!(
            registry.lookup("laptop", "0000"),
            Err(LookupError::NotFound)
        );
    }

    #[test]
    fn entries_expire_after_the_ttl() {
        let (registry, clock) = registry(10);
        let ids = register(&registry, "laptop", 1);
        clock.advance(TTL);
        assert_eq!(
            registry.lookup("laptop", &ids[0]),
            Err(LookupError::Expired)
        );
        // The expired entry is gone: the same id is now plain not-found.
        assert_eq!(
            registry.lookup("laptop", &ids[0]),
            Err(LookupError::NotFound)
        );
    }

    #[test]
    fn expiry_is_per_entry_not_per_owner() {
        let (registry, clock) = registry(10);
        let first = register(&registry, "laptop", 1);
        clock.advance(TTL / 2);
        let second = register(&registry, "laptop", 1);
        clock.advance(TTL / 2 + Duration::from_millis(1));
        assert_eq!(
            registry.lookup("laptop", &first[0]),
            Err(LookupError::Expired)
        );
        registry.lookup("laptop", &second[0]).unwrap();
    }

    #[test]
    fn cap_evicts_the_oldest_ids() {
        let (registry, _) = registry(3);
        let first = register(&registry, "laptop", 1);
        register(&registry, "laptop", 3);
        // Capacity 3: the first id was evicted by the later three.
        assert_eq!(
            registry.lookup("laptop", &first[0]),
            Err(LookupError::NotFound)
        );
    }

    #[test]
    fn eviction_and_ttl_do_not_touch_other_owners() {
        let (registry, _) = registry(2);
        let laptop = register(&registry, "laptop", 2);
        let phone = register(&registry, "phone", 1);
        register(&registry, "laptop", 2);
        assert_eq!(
            registry.lookup("laptop", &laptop[0]),
            Err(LookupError::NotFound)
        );
        registry.lookup("phone", &phone[0]).unwrap();
    }
}
