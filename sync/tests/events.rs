//! The event wire shape: every arm of the mapping, and the exact JSON a page receives.
//!
//! The launcher decodes one vocabulary across the prongs, so this is a contract rather
//! than a detail: the browser's glue builds the same objects by hand, and every native
//! host serializes `WireEvent`. An absent field must be absent from the JSON rather than
//! null, because the page's own reader treats a missing name and a null one the same but
//! a future one might not.

use iroh::SecretKey;
use lithic_sync::{SyncEvent, WireEvent};

/// One event, and what the page should read out of it.
struct Case {
    event: SyncEvent,
    kind: &'static str,
    name: Option<&'static str>,
    from: Option<String>,
    reason: Option<&'static str>,
}

#[test]
fn every_event_maps_to_the_wire_shape_a_page_reads() {
    let peer = SecretKey::generate().public();
    let cases: Vec<Case> = vec![
        Case {
            event: SyncEvent::RemoteUpdate {
                name: "notes.lith".to_string(),
                base: None,
                head: Default::default(),
                from: peer,
            },
            kind: "remote-update",
            name: Some("notes.lith"),
            from: Some(peer.to_string()),
            reason: None,
        },
        Case {
            event: SyncEvent::Seeded {
                name: "notes.lith".to_string(),
            },
            kind: "seeded",
            name: Some("notes.lith"),
            from: None,
            reason: None,
        },
        Case {
            event: SyncEvent::ExternalDrift {
                name: "notes.lith".to_string(),
            },
            kind: "external-drift",
            name: Some("notes.lith"),
            from: None,
            reason: None,
        },
        Case {
            event: SyncEvent::PeerUp(peer),
            kind: "peer-up",
            name: None,
            from: Some(peer.to_string()),
            reason: None,
        },
        Case {
            event: SyncEvent::PeerDown(peer),
            kind: "peer-down",
            name: None,
            from: Some(peer.to_string()),
            reason: None,
        },
        Case {
            event: SyncEvent::Failed {
                name: "notes.lith".to_string(),
                reason: "the folder is read-only".to_string(),
            },
            kind: "failed",
            name: Some("notes.lith"),
            from: None,
            reason: Some("the folder is read-only"),
        },
    ];

    for Case {
        event,
        kind,
        name,
        from,
        reason,
    } in cases
    {
        let wire = WireEvent::from(&event);
        assert_eq!(wire.kind, kind);
        assert_eq!(wire.name.as_deref(), name);
        assert_eq!(wire.from, from);
        assert_eq!(wire.reason.as_deref(), reason);

        let json = serde_json::to_value(&wire).expect("a wire event should serialize");
        assert_eq!(json["kind"], kind);
        for (key, want) in [("name", name), ("from", from.as_deref()), ("reason", reason)] {
            match want {
                Some(want) => assert_eq!(json[key], want, "{kind} should carry {key}"),
                None => assert!(json.get(key).is_none(), "{kind} should not carry {key}"),
            }
        }
    }

    // The patch a `RemoteUpdate` carries is deliberately not on the wire: the host that
    // needs those bytes reads the entry instead.
    let update = SyncEvent::RemoteUpdate {
        name: "notes.lith".to_string(),
        base: None,
        head: Default::default(),
        from: peer,
    };
    let json = serde_json::to_value(WireEvent::from(&update)).expect("a wire event should serialize");
    assert!(json.get("base").is_none());
    assert!(json.get("head").is_none());
}
