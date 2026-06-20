# Make a Custom Sprite Sheet for iNat Battler

This guide gives you a ready-to-paste prompt for generating a creature sprite
sheet in the iNat Battler art style, plus everything the app needs the image to
look like so it imports cleanly.

You can paste the prompt below into **ChatGPT (with image generation / GPT
Image)** in the browser, fill in the species, and download the result. Then
upload it through **Settings → Sprites** in the app.

> This file is intended to live in the standalone custom-sprite repo. It mirrors
> exactly how the in-app generator builds its prompts (`buildSpriteSheetPromptV2`
> in `src/moves.js`) and how the app slices and cleans the finished sheet.

---

## How the app uses your image

Understanding these constraints is the difference between a sprite that drops
straight in and one that looks broken in battle:

- **It's a 4×4 sprite sheet — 16 equal square cells.** 4 rows × 4 columns.
  Each row is a 4-frame animation that reads **left → right**.
- **Each row is an animation loop:**
  - **Row 1 — Idle:** alert resting pose, subtle breathing / small head moves.
  - **Row 2 — Movement:** the species' natural locomotion cycle (walk, hop,
    fly, swim, slither…).
  - **Row 3 — Signature attack:** a distinctive offensive move.
  - **Row 4 — Special / ecological attack:** a second, *visibly different* move
    grounded in the real species' behavior.
- **Same character, same scale, centered in every cell.** The app plays each
  cell as a frame, so the creature must not drift, resize, or get cropped
  between cells.
- **Plain, flat, light, OPAQUE background — not transparent.** The app removes
  the background itself by flood-filling inward from each cell's corners and
  keying out light pixels. For that to work the background must be a single
  uniform light neutral color with clear contrast against the creature, and
  **must not touch / blend into** the creature's outline. Do **not** ask for a
  transparent background, and do **not** add scenery, gradients, drop shadows
  that bleed to the edges, or grid lines.
- **No text, labels, UI, borders, or visible grid lines** anywhere on the sheet.
- **Preserve the real species.** Accurate colors, markings, silhouette, and
  proportions / field marks — a stylized "battle-spirit," not a generic monster.

### Image specs

| Setting | Value |
|---|---|
| Layout | 4×4 grid (16 cells) |
| Aspect ratio | **Square (1:1)** |
| Recommended size | **1024×1024** (so each cell is 256×256) |
| Background | Plain light neutral, **opaque** (e.g. soft off-white / pale gray) |
| Style | Crisp pixel art, clean dark outlines, limited palette |
| File type for upload | PNG, JPEG, or WebP — **under 12 MB** |

---

## The prompt (copy this)

Replace the bracketed parts with your species, then paste into ChatGPT. The
species name and a couple of behavior notes are usually all you need to change.

```text
Create one clean 4x4 pixel-art sprite sheet (16 equal square cells: 4 rows,
4 columns, left to right = animation frames 1-4 of each row) for an original
biodiversity creature-battler game. Output a square image, 1024x1024.

SUBJECT: a stylized battle-spirit of the real species [COMMON NAME]
([Scientific name]). Preserve the true field marks of this species: accurate
colors, markings, silhouette, and proportions, with a charming but battle-ready
expression. The SAME character at the SAME scale appears in every cell, centered
in its cell, crisp pixel art with clean dark outlines and a limited palette,
plain light neutral OPAQUE background (a single flat light color, no gradient),
no scenery, no text, no UI, no borders, no visible grid lines.

ANIMATION ROWS:
Row 1 - IDLE loop: alert resting pose with subtle breathing and small head
movements.
Row 2 - MOVEMENT loop: [natural locomotion for this species, e.g. hopping /
flapping flight / running / swimming].
Row 3 - SIGNATURE MOVE "[Move name]": [short description of a distinctive attack
grounded in this species' real behavior].
Row 4 - SPECIAL MOVE "[Move name]": [a second, visibly different attack grounded
in this species' real behavior or ecology].

Each row reads as a smooth 4-frame loop with clear silhouette changes between
frames; exaggerate key poses for small-size game readability. Rows 3 and 4
should feel distinct from each other. Keep the creature fully inside each cell
with even margins so it is never cropped.

Avoid: text, labels, logos, UI, scenery, complex or dark background,
transparency, extra unrelated creatures, humans, copyrighted monster-franchise
styles, messy or uneven grid, inconsistent character between cells, scale changes
between cells, cropped sprites, blurry pixels, photorealism, malformed anatomy,
random fantasy traits that erase the real species identity.
```

### Worked example (Blue Jay)

```text
...
SUBJECT: a stylized battle-spirit of the real species Blue Jay (Cyanocitta
cristata). ...

ANIMATION ROWS:
Row 1 - IDLE loop: alert perched pose, crest twitching, subtle breathing.
Row 2 - MOVEMENT loop: short bounding hops with a flick of the tail.
Row 3 - SIGNATURE MOVE "Mobbing Cry": head thrown back mid-screech, wings half
spread, a burst of sound lines.
Row 4 - SPECIAL MOVE "Acorn Cache Slam": darts forward and drives a stashed acorn
downward like a hammer.
...
```

---

## Tips for a clean result

- If ChatGPT adds gaps, labels, or uneven cells, reply: *"Make it an exact 4×4
  grid of equal square cells, no gridlines, no text, same character and scale in
  every cell."*
- If the background isn't flat, reply: *"Use a single flat light neutral
  background color across the whole image, fully opaque, no gradient or shadow
  touching the edges."* (A flat background is what lets the app cut it out.)
- Keep the creature off the cell edges — a little margin per cell prevents the
  app from clipping frames.
- If a species needs a reference, you can attach a clear photo and add: *"Match
  the real colors and markings from this reference, but redraw as original pixel
  art — do not copy the photo background."*

---

## Uploading to the app

1. Sign in and go to **Settings → Sprites**.
2. Choose your sprite sheet file (PNG / JPEG / WebP, under 12 MB) and the species
   it belongs to.
3. Submit. Your upload goes through the Discord QA flow; once approved it can
   become the in-game art. Pending submissions stay private to you.
