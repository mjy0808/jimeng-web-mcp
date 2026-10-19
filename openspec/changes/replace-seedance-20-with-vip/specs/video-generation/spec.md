## ADDED Requirements
### Requirement: Explicit VIP video routing
The service SHALL accept seedance-2.0-vip and seedance-2.0-fast-vip as exact VIP selections, mapped to dreamina_seedance_40_pro_vision and dreamina_seedance_40_vision respectively. It SHALL check the account model name, status, resolution and corresponding VIP commerce key before uploading. Both models SHALL use 24fps and integer durations from 4 to 15 seconds; standard VIP SHALL expose 720p/1080p/4k and Fast VIP SHALL expose 720p.

#### Scenario: VIP selected
- **WHEN** a caller explicitly submits a supported VIP selection
- **THEN** the root model and draft model SHALL use that VIP route, with the account price for the exact requested resolution, without downgrading or retrying

#### Scenario: VIP unavailable or wrong price
- **WHEN** the account omits the exact VIP model, resolution, or matching VIP benefit type
- **THEN** the request SHALL fail before uploads or generation

### Requirement: No silent VIP conversion
The service SHALL reject retired seedance-2.0 and seedance-2.0-fast new submissions and SHALL keep historical task queries bound to the original task ID. Film Studio SHALL display explicit VIP names.

#### Scenario: Retired model selected
- **WHEN** an old non-VIP alias is submitted
- **THEN** the request SHALL be rejected without uploading, submitting, or automatically selecting a VIP model
