use std::path::{Path, PathBuf};

use crate::error::EngineUnavailable;

/// How to start the engine: the given command, `MCPWATCH_ENGINE`, `mcpwatch` on the PATH, else npx.
///
/// The resolution order is the same in the Python and Java adapters, so the same environment starts
/// the same engine whichever language the guarded server is written in.
pub(crate) fn engine_command(
    configured: Option<&[String]>,
) -> Result<Vec<String>, EngineUnavailable> {
    let mut command: Option<Vec<String>> = configured.filter(|c| !c.is_empty()).map(|c| c.to_vec());

    if command.is_none()
        && let Ok(from_env) = std::env::var("MCPWATCH_ENGINE")
        && !from_env.trim().is_empty()
    {
        command = Some(split_command(&from_env));
    }

    if let Some(mut command) = command
        && !command.is_empty()
    {
        command.push("engine".to_string());
        return Ok(command);
    }

    if let Some(found) = on_path("mcpwatch") {
        return Ok(vec![found.to_string_lossy().into_owned(), "engine".into()]);
    }
    if let Some(npx) = on_path("npx") {
        return Ok(vec![
            npx.to_string_lossy().into_owned(),
            "-y".into(),
            crate::NPM_PACKAGE.into(),
            "engine".into(),
        ]);
    }
    Err(EngineUnavailable::NotInstalled)
}

/// Splits a command line on spaces, keeping quoted paths whole. Backslashes are left alone.
///
/// A Windows path such as `"C:\Program Files\node.exe"` must survive in one piece, which is why
/// this is not a general shell lexer: unescaping backslashes would break exactly that case.
pub(crate) fn split_command(command: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut any = false;

    for c in command.chars() {
        match quote {
            Some(q) => {
                if c == q {
                    quote = None;
                } else {
                    current.push(c);
                }
            }
            None if c == '"' || c == '\'' => {
                quote = Some(c);
                any = true;
            }
            None if c.is_whitespace() => {
                if any || !current.is_empty() {
                    out.push(std::mem::take(&mut current));
                    any = false;
                }
            }
            None => current.push(c),
        }
    }
    if any || !current.is_empty() {
        out.push(current);
    }
    out
}

/// Finds an executable on the PATH, trying the Windows extensions where they apply.
fn on_path(program: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let windows = cfg!(windows);
    let names: Vec<String> = if windows {
        vec![
            format!("{program}.cmd"),
            format!("{program}.exe"),
            format!("{program}.bat"),
            program.to_string(),
        ]
    } else {
        vec![program.to_string()]
    };

    for dir in std::env::split_paths(&path) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        for name in &names {
            let candidate = dir.join(name);
            if is_executable(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    match std::fs::metadata(path) {
        Ok(meta) => meta.is_file() && meta.permissions().mode() & 0o111 != 0,
        Err(_) => false,
    }
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds_the_engine_subcommand() {
        let configured = vec!["node".to_string(), "cli.js".to_string()];
        assert_eq!(
            engine_command(Some(&configured)).unwrap(),
            vec!["node", "cli.js", "engine"]
        );
    }

    #[test]
    fn keeps_a_quoted_windows_path_whole() {
        assert_eq!(
            split_command(r#""C:\Program Files\node.exe""#),
            vec![r"C:\Program Files\node.exe"]
        );
    }

    #[test]
    fn splits_on_spaces_but_not_inside_quotes() {
        assert_eq!(split_command(r#"node "a b.js""#), vec!["node", "a b.js"]);
    }

    #[test]
    fn an_empty_quoted_argument_survives() {
        // `any` exists for exactly this: "" is an argument, not nothing at all.
        assert_eq!(split_command(r#"node """#), vec!["node", ""]);
    }
}
