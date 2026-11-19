// Shared OpenAI-compatible Chat Completions transport. Each concrete driver
// wraps this and adds its own catalog endpoints and error classification:
// the transport never decides what a status means.
pub mod deepseek;
pub mod kimi;
pub mod local;
pub mod mimo;
pub mod openai;
pub mod openaicompat;
pub mod opencode;
pub mod openrouter;
pub mod tokenator;
pub mod workbuddy;
pub mod zai;

/// First line of an error body, capped to `limit` bytes. Slicing at a fixed
/// byte would panic inside a multi-byte character, and this excerpt runs in
/// background catalog refreshes: a panic there stops every later refresh.
pub(crate) fn error_excerpt(body: &str, limit: usize) -> String {
    let single_line = body.lines().next().unwrap_or("");
    if single_line.len() <= limit {
        return single_line.to_owned();
    }
    let mut end = limit;
    while !single_line.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &single_line[..end])
}

#[cfg(test)]
mod tests {
    use super::error_excerpt;

    #[test]
    fn cuts_on_a_character_boundary() {
        // 199 ASCII characters then a 3-byte euro sign: byte 200 is inside it.
        let body = format!("{}{}", "a".repeat(199), "\u{20ac}");
        let cut = error_excerpt(&body, 200);
        assert_eq!(cut.len(), 199 + "…".len());
        assert!(!cut.contains('\u{20ac}'));
    }
}
