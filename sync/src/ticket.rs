//! Pairing tickets.
//!
//! A ticket is the string one device shows and another pastes. It carries
//! the namespace and the addresses to dial, and the capability inside it
//! decides what the joining device may do.

use std::str::FromStr;

use anyhow::{Context, Result};
use iroh::EndpointAddr;
use iroh_docs::{Capability, CapabilityKind, DocTicket};

/// What a ticket lets the joining device do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TicketMode {
    /// The device can read and write every file in the folder.
    Write,
    /// The device can read every file, for archival.
    ReadOnly,
}

/// A parsed pairing ticket.
#[derive(Debug, Clone)]
pub struct Ticket {
    raw: DocTicket,
    mode: TicketMode,
}

impl Ticket {
    pub(crate) fn from_raw(raw: DocTicket) -> Self {
        let mode = match raw.capability.kind() {
            CapabilityKind::Write => TicketMode::Write,
            CapabilityKind::Read => TicketMode::ReadOnly,
        };
        Self { raw, mode }
    }

    /// What the ticket lets the joining device do.
    pub fn mode(&self) -> TicketMode {
        self.mode
    }

    /// The document this ticket points at, as hex.
    pub fn namespace(&self) -> String {
        crate::engine::hex(self.raw.capability.id().as_bytes())
    }

    /// The ticket text, safe to show as a QR code or copy by hand.
    pub fn to_text(&self) -> String {
        self.raw.to_string()
    }

    pub(crate) fn capability(&self) -> Capability {
        self.raw.capability.clone()
    }

    pub(crate) fn nodes(&self) -> Vec<EndpointAddr> {
        self.raw.nodes.clone()
    }
}

impl FromStr for Ticket {
    type Err = anyhow::Error;

    fn from_str(text: &str) -> Result<Self> {
        let raw = text
            .trim()
            .parse::<DocTicket>()
            .context("this is not a device sync ticket")?;
        Ok(Self::from_raw(raw))
    }
}

impl std::fmt::Display for Ticket {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.raw.to_string())
    }
}
