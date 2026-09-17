//! Telling *your* contract's failure from someone else's.
//!
//! In Soroban, "the call returned a contract error" is ambiguous. A
//! `#[contracterror]` raised by the contract under test and one raised by a
//! contract it calls — a token, an oracle, a registry — arrive through the
//! **same channel** and are distinguishable only by value. A host-level failure
//! such as a rejected `require_auth` arrives through that channel too, carrying a
//! host error rather than a contract one.
//!
//! Two bugs follow from getting this wrong, and the Topic 4 prototype shipped
//! both before they were caught:
//!
//! - **False positive.** A harness that treats "any contract error" as "my
//!   contract rejected this" fails when the *token* rejects an unaffordable
//!   transfer. That one surfaced only because a shrinker wandered into it while
//!   minimising an unrelated genuine failure.
//! - **False negative.** A harness that asserts merely `result.is_err()` passes
//!   when the contract failed for an unrelated reason. That is how a seeded
//!   arithmetic bug went undetected: the wrapped product tripped a *downstream*
//!   guard, so the buggy contract did abort — just with the wrong error.
//!
//! The rule these helpers encode: **assert which error, not that there was one.**

use soroban_sdk::{Error, InvokeError};

/// The failure channel of a generated client's `try_*` call.
///
/// `Ok(e)` carries an error value — the contract's own, a callee's, or the
/// host's. `Err(_)` is an invocation-level failure.
pub type TryErr = Result<Error, InvokeError>;

/// The full return of a `try_*` call.
pub type TryResult<T, C> = Result<Result<T, C>, TryErr>;

/// Does this failure carry exactly the contract error `code`?
///
/// Pass the discriminant of your `#[contracterror]` variant — `MyError::Foo as u32`.
pub fn is_error_code(e: &TryErr, code: u32) -> bool {
    matches!(e, Ok(err) if *err == Error::from_contract_error(code))
}

/// Does this failure carry any of `codes`?
pub fn is_any_error_code(e: &TryErr, codes: &[u32]) -> bool {
    codes.iter().any(|c| is_error_code(e, *c))
}

/// Did this call fail with exactly the contract error `code`?
pub fn failed_with<T, C>(r: &TryResult<T, C>, code: u32) -> bool {
    matches!(r, Err(e) if is_error_code(e, code))
}

/// Did this call fail with an error that is **not** one of the contract's own?
///
/// This is the predicate for "it was rejected, but not by the logic under test" —
/// a rejected `require_auth`, a host trap, or a callee contract's error.
///
/// Use it for authorization assertions. The tempting alternative, "it failed at
/// all", passes when the call was rejected for an unrelated reason such as a
/// paused contract or an invalid amount, which silently degrades the property
/// into the weak `is_err()` oracle.
///
/// `own_codes` is the complete list of the subject's own error discriminants. It
/// must be complete: a code left out here is a code that will be misread as
/// someone else's failure.
pub fn failed_externally<T, C>(r: &TryResult<T, C>, own_codes: &[u32]) -> bool {
    match r {
        Err(Err(_)) => true,
        Err(Ok(e)) => !own_codes
            .iter()
            .any(|c| *e == Error::from_contract_error(*c)),
        Ok(_) => false,
    }
}

/// Did this call fail with one of the contract's *own* errors?
pub fn failed_internally<T, C>(r: &TryResult<T, C>, own_codes: &[u32]) -> bool {
    matches!(r, Err(e) if is_any_error_code(e, own_codes))
}

#[cfg(test)]
mod tests {
    use super::*;

    const OWN: &[u32] = &[1, 2, 3, 4, 5, 6, 7];

    fn own(code: u32) -> TryResult<(), ()> {
        Err(Ok(Error::from_contract_error(code)))
    }
    fn foreign(code: u32) -> TryResult<(), ()> {
        Err(Ok(Error::from_contract_error(code)))
    }
    fn host() -> TryResult<(), ()> {
        Err(Err(InvokeError::Abort))
    }
    fn ok() -> TryResult<(), ()> {
        Ok(Ok(()))
    }

    #[test]
    fn discriminates_between_the_contracts_own_codes() {
        assert!(failed_with(&own(5), 5));
        assert!(!failed_with(&own(5), 6));
    }

    #[test]
    fn a_callees_error_is_external_even_though_it_is_a_contract_error() {
        // The token's error #10 travels through the same channel as our #5.
        assert!(failed_externally(&foreign(10), OWN));
        assert!(!failed_internally(&foreign(10), OWN));
    }

    #[test]
    fn our_own_error_is_not_external() {
        // This is the false-negative guard: an auth assertion must not be
        // satisfied by the contract rejecting for its own unrelated reason.
        for code in OWN {
            assert!(!failed_externally(&own(*code), OWN), "code {code}");
        }
    }

    #[test]
    fn host_failures_are_external() {
        assert!(failed_externally(&host(), OWN));
        assert!(!failed_internally(&host(), OWN));
    }

    #[test]
    fn success_is_never_a_failure_of_either_kind() {
        assert!(!failed_externally(&ok(), OWN));
        assert!(!failed_internally(&ok(), OWN));
        assert!(!failed_with(&ok(), 1));
    }

    #[test]
    fn an_incomplete_own_code_list_misreads_our_error_as_someone_elses() {
        // Documents the one way to hold this wrong: leave a code out and the
        // predicate silently starts accepting it.
        let incomplete: &[u32] = &[1, 2, 3];
        assert!(failed_externally(&own(7), incomplete));
        assert!(!failed_externally(&own(7), OWN));
    }
}
