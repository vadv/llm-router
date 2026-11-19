// User-facing metamodel: an ordered list of model references. Position is
// priority. The service validates user data and delegates persistence to the
// pool adapter; derived facts are computed from the catalog at read time.

use std::collections::HashSet;

use crate::model::{CatalogError, ModelCatalog, ModelId, ProviderId};
use crate::storage::StorageError;
use crate::storage::pools::{PoolMember, PoolStore, StoredPool};

/// External name of a metamodel — the model name clients request.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct MetamodelId(String);

impl MetamodelId {
    pub fn new(value: impl Into<String>) -> Self {
        MetamodelId(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for MetamodelId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Metamodel {
    id: MetamodelId,
    members: Vec<ModelId>,
}

/// A repeated member would make the priority order ambiguous.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DuplicateMember(pub ModelId);

impl Metamodel {
    pub fn new(id: MetamodelId, members: Vec<ModelId>) -> Result<Self, DuplicateMember> {
        let mut seen = HashSet::new();
        for member in &members {
            if !seen.insert(member) {
                return Err(DuplicateMember(member.clone()));
            }
        }
        Ok(Metamodel { id, members })
    }

    pub fn id(&self) -> &MetamodelId {
        &self.id
    }

    /// First member has the highest priority.
    pub fn members(&self) -> &[ModelId] {
        &self.members
    }

    /// Minimum of the known context windows. A member missing from the
    /// catalog is skipped; an unknown window does not lower the minimum;
    /// when nothing is known the answer is unknown, never zero.
    pub fn context_tokens(&self, catalog: &dyn ModelCatalog) -> Result<Option<u64>, CatalogError> {
        let mut min: Option<u64> = None;
        for member in &self.members {
            let model = catalog.find(member)?;
            if let Some(tokens) = model.and_then(|m| m.context_tokens) {
                min = match min {
                    None => Some(tokens),
                    Some(current) => Some(current.min(tokens)),
                };
            }
        }
        Ok(min)
    }
}

#[derive(Debug)]
pub struct MetamodelError(pub String);

impl std::fmt::Display for MetamodelError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "metamodel: {}", self.0)
    }
}
impl std::error::Error for MetamodelError {}

impl From<StorageError> for MetamodelError {
    fn from(e: StorageError) -> Self {
        MetamodelError(e.0)
    }
}

impl From<DuplicateMember> for MetamodelError {
    fn from(e: DuplicateMember) -> Self {
        MetamodelError(format!("duplicate member {}", e.0))
    }
}

impl From<CatalogError> for MetamodelError {
    fn from(e: CatalogError) -> Self {
        MetamodelError(e.0)
    }
}

/// CRUD over the pool adapter with domain validation. Derived facts are
/// computed per read, so catalog changes apply to the next view without any
/// synchronization of copies.
pub struct MetamodelService {
    pools: PoolStore,
}

impl MetamodelService {
    pub fn new(pools: PoolStore) -> Self {
        MetamodelService { pools }
    }

    pub fn create(&mut self, metamodel: Metamodel) -> Result<(), MetamodelError> {
        if metamodel.id().as_str().is_empty() {
            return Err(MetamodelError("name must not be empty".into()));
        }
        // Metamodel::new already proved the members have no duplicates.
        let members = to_pool_members(metamodel.members());
        self.pools.create(metamodel.id().as_str(), members)?;
        Ok(())
    }

    pub fn replace_members(
        &mut self,
        id: &MetamodelId,
        members: Vec<ModelId>,
    ) -> Result<(), MetamodelError> {
        Metamodel::new(id.clone(), members.clone())?; // validate before writing
        self.pools
            .replace_members(id.as_str(), to_pool_members(&members))?;
        Ok(())
    }

    pub fn delete(&mut self, id: &MetamodelId) -> Result<(), MetamodelError> {
        self.pools.delete(id.as_str())?;
        Ok(())
    }

    pub fn get(&self, id: &MetamodelId) -> Result<Option<Metamodel>, MetamodelError> {
        self.pools.get(id.as_str())?.map(from_stored).transpose()
    }

    pub fn list(&self) -> Result<Vec<Metamodel>, MetamodelError> {
        self.pools.list()?.into_iter().map(from_stored).collect()
    }
}

fn to_pool_members(members: &[ModelId]) -> Vec<PoolMember> {
    members
        .iter()
        .map(|m| PoolMember {
            provider_id: m.provider().as_str().to_owned(),
            upstream_id: m.upstream().to_owned(),
        })
        .collect()
}

fn from_stored(stored: StoredPool) -> Result<Metamodel, MetamodelError> {
    let members = stored
        .members
        .iter()
        .map(|m| {
            ModelId::new(
                ProviderId::new(m.provider_id.clone()),
                m.upstream_id.clone(),
            )
        })
        .collect();
    Ok(Metamodel::new(MetamodelId::new(stored.name), members)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ProviderModel;
    use std::collections::HashMap;

    /// In-memory catalog stub: only the models in the map exist.
    struct StubCatalog {
        models: HashMap<ModelId, Option<u64>>,
    }

    impl ModelCatalog for StubCatalog {
        fn find(&self, id: &ModelId) -> Result<Option<ProviderModel>, CatalogError> {
            Ok(self.models.get(id).map(|tokens| ProviderModel {
                id: id.clone(),
                context_tokens: *tokens,
                observed_at_unix: 0,
            }))
        }
    }

    fn model_id(provider: &str, upstream: &str) -> ModelId {
        ModelId::new(ProviderId::new(provider), upstream)
    }

    fn metamodel(members: Vec<ModelId>) -> Metamodel {
        Metamodel::new(MetamodelId::new("m"), members).unwrap()
    }

    #[test]
    fn rejects_duplicate_members() {
        let err = Metamodel::new(
            MetamodelId::new("m"),
            vec![model_id("p", "a"), model_id("p", "a")],
        )
        .unwrap_err();
        assert_eq!(err.0, model_id("p", "a"));
    }

    #[test]
    fn context_is_the_minimum_of_known_windows() {
        let catalog = StubCatalog {
            models: HashMap::from([
                (model_id("p", "big"), Some(200_000)),
                (model_id("p", "small"), Some(8_000)),
                (model_id("q", "unknown"), None),
            ]),
        };
        let metamodel = metamodel(vec![
            model_id("p", "big"),
            model_id("p", "small"),
            model_id("q", "unknown"),
        ]);
        assert_eq!(metamodel.context_tokens(&catalog).unwrap(), Some(8_000));
    }

    #[test]
    fn missing_member_is_skipped_not_fatal() {
        let catalog = StubCatalog {
            models: HashMap::from([(model_id("p", "a"), Some(64_000))]),
        };
        let metamodel = metamodel(vec![model_id("gone", "x"), model_id("p", "a")]);
        assert_eq!(metamodel.context_tokens(&catalog).unwrap(), Some(64_000));
    }

    #[test]
    fn context_is_unknown_when_nothing_is_known() {
        let catalog = StubCatalog {
            models: HashMap::from([(model_id("p", "a"), None)]),
        };
        let model = metamodel(vec![model_id("p", "a")]);
        assert_eq!(model.context_tokens(&catalog).unwrap(), None);

        let empty = metamodel(vec![]);
        assert_eq!(empty.context_tokens(&catalog).unwrap(), None);
    }

    #[test]
    fn catalog_read_failure_is_returned_not_hidden() {
        struct FailingCatalog;
        impl ModelCatalog for FailingCatalog {
            fn find(&self, _: &ModelId) -> Result<Option<ProviderModel>, CatalogError> {
                Err(CatalogError("locked".into()))
            }
        }
        let model = metamodel(vec![model_id("p", "a")]);
        let err = model.context_tokens(&FailingCatalog).unwrap_err();
        assert_eq!(err.0, "locked");
    }

    #[test]
    fn service_stores_and_reads_metamodels() {
        let mut service = MetamodelService::new(PoolStore::new(in_memory()).unwrap());
        service
            .create(metamodel(vec![model_id("p", "a"), model_id("q", "b")]))
            .unwrap();

        let read = service.get(&MetamodelId::new("m")).unwrap().unwrap();
        assert_eq!(read.members(), &[model_id("p", "a"), model_id("q", "b")]);

        service
            .replace_members(&MetamodelId::new("m"), vec![model_id("p", "a")])
            .unwrap();
        assert_eq!(
            service
                .get(&MetamodelId::new("m"))
                .unwrap()
                .unwrap()
                .members(),
            &[model_id("p", "a")]
        );
        assert_eq!(service.list().unwrap().len(), 1);

        service.delete(&MetamodelId::new("m")).unwrap();
        assert!(service.get(&MetamodelId::new("m")).unwrap().is_none());
    }

    #[test]
    fn service_rejects_empty_name_and_duplicate_members() {
        let mut service = MetamodelService::new(PoolStore::new(in_memory()).unwrap());
        let err = service
            .create(Metamodel::new(MetamodelId::new(""), vec![]).unwrap())
            .unwrap_err();
        assert_eq!(err.0, "name must not be empty");

        // Duplicate members are rejected at construction and at the service boundary.
        let duplicates = vec![model_id("p", "a"), model_id("p", "a")];
        assert!(Metamodel::new(MetamodelId::new("m"), duplicates.clone()).is_err());

        service.create(metamodel(vec![model_id("p", "a")])).unwrap();
        let err = service
            .replace_members(&MetamodelId::new("m"), duplicates)
            .unwrap_err();
        assert!(err.0.contains("duplicate member"));
    }

    fn in_memory() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.busy_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        conn
    }
}
