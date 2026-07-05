pub mod adapter;
pub mod claude;
pub mod codex;
pub mod events;

use adapter::EngineAdapter;

pub fn adapter_for(engine: &str) -> Option<Box<dyn EngineAdapter>> {
    match engine {
        "claude-code" => Some(Box::new(claude::ClaudeCodeAdapter)),
        "codex" => Some(Box::new(codex::CodexAdapter)),
        _ => None,
    }
}
