//! Builds the contract to WASM and hands the bytes to the fuzz target.
//!
//! The WASM arm exists because **the linked crate is not what ships**. Soroban
//! deploys a `.wasm` module and runs it in a VM, and the SDK is explicit that
//! measuring resources against a natively-linked test contract misses the costs
//! that matter:
//!
//! > "if a test contract is used instead of a Wasm contract, all the costs
//! >  related to VM instantiation and execution, as well as Wasm reads/rent
//! >  bumps will be missed."
//!
//! So any oracle built on `cost_estimate()` — instructions, memory, rent bumps,
//! disk reads — is only meaningful over the deployed artifact.
//!
//! The seed features have to be forwarded. `CARGO_FEATURE_<NAME>` is set for
//! this script whenever the fuzz crate enables a passthrough feature, so the
//! `.wasm` is built with exactly the seed the fuzz binary was built with.
//! Getting this wrong would fuzz a clean WASM while claiming to fuzz a seeded
//! one — the same class of silent mismatch that `cargo fuzz --features` already
//! produced once in this project.

use std::path::PathBuf;
use std::process::Command;

const SEEDS: &[&str] = &[
    "bug_overflow",
    "bug_missing_auth",
    "bug_zero_amount",
    "bug_self_transfer",
    "bug_no_ttl",
    "bug_temp_nonce",
    "bug_reinit",
];

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let contract = manifest.join("../contracts/soroban-vault");
    // A dedicated target directory: sharing one with the outer build deadlocks
    // on the cargo lock, since this runs *inside* a cargo invocation.
    let target_dir = manifest.join("target/wasm-build");

    println!("cargo:rerun-if-changed={}", contract.join("src").display());
    println!("cargo:rerun-if-changed={}", contract.join("Cargo.toml").display());

    let enabled: Vec<&str> = SEEDS
        .iter()
        .copied()
        .filter(|s| std::env::var(format!("CARGO_FEATURE_{}", s.to_uppercase())).is_ok())
        .collect();

    let mut cmd = Command::new("cargo");
    cmd.arg("rustc")
        .arg("--manifest-path")
        .arg(contract.join("Cargo.toml"))
        .arg("--target")
        .arg("wasm32v1-none")
        .arg("--release")
        .arg("--crate-type")
        .arg("cdylib")
        .arg("--target-dir")
        .arg(&target_dir);
    if !enabled.is_empty() {
        cmd.arg("--features").arg(enabled.join(","));
    }
    // The fuzz build sets RUSTFLAGS for SanitizerCoverage; those must not leak
    // into the wasm build, which neither needs nor supports them.
    cmd.env_remove("RUSTFLAGS");
    cmd.env_remove("CARGO_ENCODED_RUSTFLAGS");
    // cargo-fuzz runs under nightly and exports RUSTUP_TOOLCHAIN, which this
    // script would inherit. `wasm32v1-none` is normally installed for the
    // default toolchain only, so inheriting nightly fails with a bare
    // "can't find crate for `core`" — a message that points at the target
    // rather than at the toolchain and costs a while to read correctly.
    // Clearing it lets rustup resolve the directory default.
    cmd.env_remove("RUSTUP_TOOLCHAIN");
    cmd.env_remove("CARGO");
    cmd.env_remove("CARGO_BUILD_TARGET");

    let out = cmd.output().expect("failed to run cargo for the wasm build");
    if !out.status.success() {
        panic!(
            "wasm build failed:\n{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    let wasm = target_dir.join("wasm32v1-none/release/soroban_vault.wasm");
    assert!(wasm.exists(), "expected wasm at {}", wasm.display());

    println!("cargo:rustc-env=VAULT_WASM_PATH={}", wasm.display());
    println!(
        "cargo:rustc-env=VAULT_WASM_SEEDS={}",
        if enabled.is_empty() { "clean".to_string() } else { enabled.join(",") }
    );
}
