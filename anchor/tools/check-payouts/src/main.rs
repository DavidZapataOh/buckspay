use std::{env, path::Path, process::ExitCode};

fn main() -> ExitCode {
    let Some(program_dir) = env::args().nth(1) else {
        eprintln!("usage: check-payouts <program-dir containing Cargo.toml and src/>");
        return ExitCode::from(2);
    };
    match check_payouts::check_program(Path::new(&program_dir)) {
        Ok(findings) if findings.is_empty() => ExitCode::SUCCESS,
        Ok(findings) => {
            for finding in &findings {
                eprintln!(
                    "{}:{}: {}",
                    finding.file.display(),
                    finding.line,
                    finding.message
                );
            }
            eprintln!("check-payouts: {} finding(s)", findings.len());
            ExitCode::FAILURE
        }
        Err(error) => {
            eprintln!("check-payouts: {error}");
            ExitCode::from(2)
        }
    }
}
