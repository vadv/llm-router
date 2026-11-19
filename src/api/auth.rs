// Incoming key authentication: presented secret -> non-secret alias.
//
// All configured keys are equal: presenting any valid
// secret grants inference, history, and pool management. The alias, never
// the secret, is what request history records. There are no roles and no
// per-key permissions to check.
use crate::config::ClientKey;

pub struct KeyAuthenticator {
    keys: Vec<ClientKey>,
}

impl KeyAuthenticator {
    pub fn new(keys: Vec<ClientKey>) -> Self {
        KeyAuthenticator { keys }
    }

    /// The alias for a presented secret, or `None` for an unknown secret.
    /// Every configured secret is compared — no early exit on a match — so
    /// request timing does not reveal which position matched. (A length
    /// mismatch still skips that comparison: key lengths are not secret
    /// material worth a hash-length commitment.)
    pub fn authenticate(&self, presented: &str) -> Option<&str> {
        let presented = presented.as_bytes();
        let mut matched = None;
        for key in &self.keys {
            if constant_time_eq(presented, key.secret.as_bytes()) {
                matched = Some(key.alias.as_str());
            }
        }
        matched
    }
}

/// Length-checked constant-time comparison: the running OR of byte
/// differences is zero only when the slices are equal. The check is
/// deliberately outside the loop; differing lengths are not secret.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn authenticator() -> KeyAuthenticator {
        KeyAuthenticator::new(vec![
            ClientKey {
                alias: "laptop".into(),
                secret: "secret-one".into(),
            },
            ClientKey {
                alias: "phone".into(),
                secret: "secret-two".into(),
            },
        ])
    }

    #[test]
    fn a_valid_secret_yields_its_alias() {
        assert_eq!(authenticator().authenticate("secret-one"), Some("laptop"));
        assert_eq!(authenticator().authenticate("secret-two"), Some("phone"));
    }

    #[test]
    fn an_unknown_secret_is_rejected() {
        assert_eq!(authenticator().authenticate("secret-three"), None);
        assert_eq!(authenticator().authenticate(""), None);
    }

    #[test]
    fn a_partial_secret_is_rejected_without_prefix_matching() {
        assert_eq!(authenticator().authenticate("secret"), None);
        assert_eq!(authenticator().authenticate("secret-one-with-suffix"), None);
    }

    #[test]
    fn an_empty_key_list_rejects_everything() {
        assert_eq!(KeyAuthenticator::new(vec![]).authenticate("anything"), None);
    }
}
