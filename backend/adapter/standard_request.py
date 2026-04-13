from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from backend.runtime.attachment_types import NormalizedAttachment


@dataclass(slots=True)
class StandardRequest:
    prompt: str
    response_model: str
    resolved_model: str
    surface: str
    client_profile: str = "openclaw_openai"
    requested_model: str | None = None
    content: str | None = None
    stream: bool = False
    tools: list[dict[str, Any]] = field(default_factory=list)
    tool_names: list[str] = field(default_factory=list)
    tool_name_registry: dict[str, str] = field(default_factory=dict)
    tool_enabled: bool = False
    attachments: list[NormalizedAttachment] = field(default_factory=list)
    uploaded_file_ids: list[str] = field(default_factory=list)
    stage_labels: dict[str, str] = field(default_factory=dict)
