//! Smoke test: boot_trace must create the file and write greppable lines.
#[test]
fn boot_trace_writes_lines_to_taco_home_logs() {
    let tmp = std::env::temp_dir().join(format!("taco-boot-smoke-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).unwrap();
    std::env::set_var("TACO_HOME", &tmp);

    taco_desktop_lib::boot_trace::init();
    taco_desktop_lib::boot_trace::mark_rust("smoke.alpha");
    taco_desktop_lib::boot_trace::mark_rust_detail("smoke.beta", "took=7ms");
    {
        let _p = taco_desktop_lib::boot_trace::Phase::new("smoke.phase");
    }

    let log = tmp.join("logs").join("boot.log");
    assert!(log.exists(), "boot.log must be created at {:?}", log);
    let body = std::fs::read_to_string(&log).unwrap();
    for needle in ["=== boot", "smoke.alpha", "smoke.beta took=7ms",
                   "smoke.phase.start", "smoke.phase.done took="] {
        assert!(body.contains(needle), "missing {:?} in:\n{}", needle, body);
    }
    // Offsets must be present and monotonic-looking.
    assert!(body.contains("ms [rust]"), "offset+source tag missing:\n{}", body);
    let _ = std::fs::remove_dir_all(&tmp);
}
