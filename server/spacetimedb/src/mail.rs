//! Idempotent IMAP imports. Transport credentials and mailbox cursors belong
//! to the connector; the workspace stores readable pages and import receipts.

use spacetimedb::{client_visibility_filter, reducer, table, Filter, Identity, ReducerContext, Table, Timestamp};

mod accounts;
mod governance;
mod protected;
mod provenance;
pub(crate) use protected::require_no_protected_mail_collections;
use accounts::{leased, mail_connection, MailConnection};
use crate::pages::{create_component_tree_page_inner, page, PageType};
use crate::pages::components::{replace_page_doc, DocBlockInput};
use crate::types::ActorType;

#[client_visibility_filter]
const MAIL_IMPORT_RECEIPT_FILTER: Filter =
    Filter::Sql("SELECT * FROM mail_import_receipt WHERE imported_by = :sender");

#[table(accessor = mail_import_receipt, public)]
pub struct MailImportReceipt {
    #[primary_key]
    pub id: String,
    pub imported_by: Identity,
    #[index(btree)]
    pub root_page_id: u64,
    pub event_key: String,
    pub page_id: u64,
    /// Mailbox/folder/UID identity and RFC threading headers, never credentials.
    pub source_json: String,
    pub imported_at: Timestamp,
}

fn receipt_id(principal: Identity, root: u64, key: &str) -> String {
    format!("{}:{root}:{key}", principal.to_hex())
}

fn validate_import(key: &str, title: &str, source: &str, blocks: &[DocBlockInput]) -> Result<(), String> {
    if key.len() != 64 || !key.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("Mail event key must be a SHA-256 hex digest".into());
    }
    if title.trim().is_empty() || title.len() > 1024 {
        return Err("Mail title must be 1–1024 bytes".into());
    }
    if source.len() > 16_384 || !serde_json::from_str::<serde_json::Value>(source)
        .is_ok_and(|v| v.is_object()) {
        return Err("Mail source must be a JSON object of at most 16 KiB".into());
    }
    if blocks.is_empty() || blocks.len() > 16 || blocks.iter().any(|b| b.component_type != "RichText") {
        return Err("Mail imports require 1–16 plain rich-text blocks".into());
    }
    let bytes: usize = blocks.iter().map(|b| b.props_json.len() + b.yjs_state.as_ref().map_or(0, Vec::len)).sum();
    if bytes > 512 * 1024 {
        return Err("Mail document exceeds 512 KiB".into());
    }
    Ok(())
}

/// Page, body, and receipt commit together. Replaying after a lost HTTP reply
/// is a no-op, including when the imported page has since been edited/deleted.
#[reducer]
pub fn import_mail_message(
    ctx: &ReducerContext,
    connection_id: u64,
    lease: String,
    event_key: String,
    title: String,
    source_json: String,
    blocks: Vec<DocBlockInput>,
) -> Result<(), String> {
    let connection = leased(ctx, connection_id, &lease)?;
    let root_page_id = connection.root_page_id;
    let root = ctx.db.page().id().find(root_page_id).ok_or("Mail destination not found")?;
    if root.deleted_at.is_some() {
        return Err("Mail destination is in the trash".into());
    }
    validate_import(&event_key, &title, &source_json, &blocks)?;
    let id = receipt_id(connection.owner, root_page_id, &event_key);
    if ctx.db.mail_import_receipt().id().find(id.clone()).is_some() {
        return Ok(());
    }
    let page_id = create_component_tree_page_inner(
        ctx, Some(root_page_id), PageType::Doc, title,
        ActorType::Agent("mail-monitor".into()),
    )?;
    replace_page_doc(ctx, page_id, blocks)?;
    ctx.db.mail_import_receipt().insert(MailImportReceipt {
        id, imported_by: connection.owner, root_page_id, event_key, page_id,
        source_json, imported_at: ctx.timestamp,
    });
    ctx.db.mail_connection().id().update(MailConnection {
        imported_count: connection.imported_count + 1, ..connection
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn import_bounds_reject_invalid_and_oversized_documents() {
        let block = DocBlockInput { component_type: "RichText".into(), props_json: "{}".into(), yjs_state: Some(vec![1]) };
        assert!(validate_import(&"a".repeat(64), "Subject", "{}", &[block.clone()]).is_ok());
        assert!(validate_import("bad", "Subject", "{}", &[block.clone()]).is_err());
        assert!(validate_import(&"a".repeat(64), "Subject", "[]", &[block.clone()]).is_err());
        let huge = DocBlockInput { yjs_state: Some(vec![0; 512 * 1024]), ..block };
        assert!(validate_import(&"a".repeat(64), "Subject", "{}", &[huge]).is_err());
    }
}
