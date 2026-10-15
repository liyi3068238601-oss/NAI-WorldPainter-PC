# M4 prompt-resource source and parity audit

Audit snapshot: 2026-10-15. Machine-readable complete capsule key differences and per-image checksums are in [capsule-parity.json](capsule-parity.json).

## Mobile style and artist materials

The local read-only mobile snapshot is `feat/mobile-preview-v5` at `01e85981a52b5d45d3cb6d1ee03a8604fe53d9ab`. It contains 24 style rows and 24 JPG previews (6817605 bytes), plus 137 artist rows and 137 JPG previews (8898579 bytes). JSON SHA-256: styles `1581BE07F38A5D501C4EFF16F6BC536E079A66E6C2AB90718AFE05F7F1816C3A`; artists `39C1A7E7F7F7D286DFC3948F21460B020C7AA1787B6179B5C15DD42D2CD8E0B0`. Individual image hashes are preserved in the JSON evidence.

The official upstream master resolved during this audit to `375a41844be53136f7d2350c2d6560f221a8c5a5`. Its README advertises the same 24/137 counts, but the repository root `LICENSE` URL returned 404 and its credits do not identify a source or grant for these JSON/JPG materials. Counts and public availability are not redistribution permission. Therefore the data and thumbnails are not bundled. The importer implemented alongside this audit accepts user-selected JSON and separately selected image files, preserves missing-preview status, and writes only to that user's libraries.

The local asset history shows the style JSON and previews first entered at `d09fb8df450d7ef2f55f0d9c9f13324ea0690785` (2026-06-06), and the artist JSON and previews at `a7161a8b8b4b6ac0677e0385a443258100794af6` (2026-06-07). These commits contain no asset-specific license/source record; the exact per-file image checksums are in the JSON evidence.

## Existing desktop capability and remaining gap

The migrated desktop already provides a user style library with CRUD, prompt application, sorting/groups, batch text import, persistent local preview images (up to nine per style), and image-copy IPC. Its artist favorites are generated recipes/images rather than a browseable individual artist-tag library. It has curated Danbooru artist tags and a large searchable catalog, but neither supplies the mobile artist rows' categories and thumbnails. The new importer keeps these libraries separate and appends; it never replaces existing user data.

## Capsule parity

The phone README's ~6,747 count is the raw expansion encoding. Runtime merges only three expansion batches and de-duplicates by category plus English tag; the separate 462-row base taxonomy is not used by that runtime merge. This yields 2258 phone runtime rows across 14 categories / 95 subgroups. The PC's MIT-derived taxonomy has 4121 rows across 14 categories / 112 subgroups.

All 2218 unique English tag strings used by the phone runtime are covered in the PC list; there are **0 missing English strings**. This establishes English-tag coverage only, not exact taxonomy parity. Exact `(category, subgroup, English tag)` keys overlap on 2108 records; 150 phone keys have different placement in PC. Among shared exact keys, 17 Chinese labels differ. The complete phone-only keys, their PC rows with the same English tag, all PC-only keys, and all translation mismatches are enumerated in `capsule-parity.json`.

The earlier Flutter capsule extraction manifest pins `novelai-image-desktop` commit `2d609393c3902874afae5200c26165d86b76055f` and records the MIT text hash plus source-file hashes. The local capsule/prompt source files match that older fixed provenance; do not describe them as direct copies of the phone capsule source. No phone prompt data or images are bundled by this change.

## Electron migration overlay

The active desktop source was subsequently imported from `novelai-image-desktop` commit `7bc76ded4f539949a52f29fba32e2d896d2f89b7`; see `docs/evidence/electron-migration/`. The older extraction hash above describes the earlier Flutter capsule baseline, not the Electron application revision. Original phone prompting instructions and knowledge JSON are bundled with their provenance; the unlicensed 24 style and 137 artist thumbnail collections remain local-import-only.
