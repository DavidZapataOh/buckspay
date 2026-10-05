//! Nothing but `spent::apply` creates a `Spent` or changes its content or flags.
use std::{fs, path::Path};

fn sources(dir: &Path, out: &mut Vec<(String, String)>) {
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            sources(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push((
                path.display().to_string(),
                fs::read_to_string(&path).unwrap(),
            ));
        }
    }
}

#[test]
fn spent_is_written_only_by_apply() {
    let mut files = vec![];
    sources(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
        &mut files,
    );
    for (path, text) in files {
        if path.ends_with("src/spent.rs") || path.ends_with("src/state.rs") {
            continue;
        }
        for needle in [
            "= Spent {",
            "(Spent {",
            "spent.flags",
            "spent.content",
            "Account::<Spent>",
            "Account<Spent>",
        ] {
            let allowed = path.ends_with("close_spent.rs") && needle == "Account::<Spent>";
            assert!(
                allowed || !text.contains(needle),
                "{path} touches Spent: {needle}"
            );
        }
    }
}
