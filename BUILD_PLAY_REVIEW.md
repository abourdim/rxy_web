# Build / Play full review — web app v2.13

This release reviews Build and Play as one stateful editor/runtime system. The goal is simple: view operations must never rewrite a design, Play must never silently control a different CFG than the one shown, and switching modes must be deterministic.

## State model

- **Build is the authoritative editable project.** Its widget geometry and logical canvas are the data exported to Layout JSON / MakeCode CFG.
- **Disconnected Play is a deep-cloned preview of Build.** Runtime changes cannot mutate Build through shared object references.
- **Connected Play uses only the last verified device CFG.** While CFG version/cache validation is pending, live runtime controls are hidden rather than substituting the Build draft.
- **Play Arrange syncs back to Build only when Play originated from Build.** Arranging a device-loaded CFG stays independent and can be exported explicitly.

## Geometry invariants

- Build → Play → Build does not alter `x`, `y`, `w`, `h`, or canvas dimensions.
- Fit, 1:1, zoom, pan, browser resize, fullscreen, and mode switching are view-only.
- Only explicit editing operations may change geometry: drag/resize/property edits, Tidy, Trim Canvas, and Play Arrange.
- No hidden overlap resolver or automatic Tidy runs during rendering or tab switching.
- Runtime Arrange is zoom-correct: pointer deltas are converted to logical coordinates.
- Arrange may expand the logical canvas when content crosses its edge, but never shrinks it implicitly.
- Legacy imports without canvas metadata derive a fresh canvas from their own content instead of inheriting the previous project’s canvas.
- Loading a template also starts with a fresh canvas.

## Build review fixes

- Removed implicit overlap/repacking behavior from Build rendering.
- Scoped Build keyboard shortcuts to Build only; driving in Play cannot nudge hidden Build widgets.
- Scoped shake/magic-style editing to Build only.
- Persisted manual Build zoom separately from Play zoom.
- Preserved Build zoom when leaving Play Arrange through the Build tab; the delayed Play Fit callback can no longer force Fit Design in Build.
- Group membership is normalized to one parent per child.
- Separator widgets keep genuinely thin resize limits.
- URL layout import now uses the same state/import path as file import.
- Import/template paths invalidate stale Play snapshots and stale canvas dimensions.
- Undo/Redo snapshots include logical canvas size as well as widget geometry.

## Play review fixes

- Play runtime bindings are lifecycle-owned and cleaned before rerender/exit, preventing joystick/XY/timer listener accumulation.
- Leaving Play or entering Arrange releases held D-pad state as a motor-safety boundary.
- Arrange mode blocks the embedded runtime controls, so dragging a slider/D-pad/select cannot also command the robot.
- Generic button release is immediate; the old 100 ms release delay is removed.
- Hidden widgets are not rendered in Play and do not affect Fit.
- Fit uses occupied functional widget bounds instead of empty authoring canvas space.
- 1:1/manual zoom still exposes the complete logical canvas with normal scrolling.
- Oversized logical canvases (for example 2068×1301) no longer force Fit to show dead space.
- Fullscreen Fit uses the actual available height below the fullscreen title/toolbar; it no longer extends below the viewport.
- Fullscreen title and toolbar reserve separate horizontal space, and the controller frame is dynamically pushed below wrapped fullscreen chrome at narrow widths.
- Entering Play or connecting never enters fullscreen automatically.
- A queued automatic Fit cannot override an immediate user-selected manual Play zoom.
- Swipe-to-fullscreen ignores gestures that begin on runtime controls, avoiding accidental fullscreen from sliders/joysticks.

## Connected CFG safety

- A newly connected GATT session clears the previous runtime CFG before version/cache validation.
- Connected Play never substitutes local Build controls while the device CFG is unverified.
- `Reload Config` now treats the current CFG as stale: held drive state and runtime bindings are stopped, old live controls are hidden, and Play is revealed again only after the fresh CFG is verified.
- Device-loaded Arrange sessions do not pollute Build Undo history.

## Regression validation

Automated headless Chromium checks were run against the current v2.13 source.

### State / geometry suite

27 Build/Play regression checks passed with zero page errors, including:

- Build Fit and 1:1 are view-only.
- Manual Build zoom persists.
- Build → Play → Build geometry is stable.
- Mode switching does not grow Undo history.
- Legacy import and template load do not inherit stale oversized canvases.
- Disconnected Play is a deep Build snapshot.
- Connected-unverified Play hides controls.
- Connected Play uses verified device CFG.
- Hidden widgets are omitted.
- Play Fit contains every visible functional widget.
- Play 1:1 exposes the full logical canvas.
- Arrange drag is correct at 50% zoom.
- Arrange blocks runtime command activation.
- Device Arrange does not affect Build Undo.
- Build-origin Arrange syncs explicitly.
- Runtime listener cleanup remains stable through repeated rerenders.
- Build shortcuts are inactive in Play.
- Group membership is single-parent.
- Fit/zoom preserve export geometry.
- Manual Play zoom wins over queued auto-Fit.
- A 2068×1301 canvas is fitted to occupied content rather than dead space.
- Oversized fullscreen Fit keeps every functional widget visible.

### Responsive/fullscreen suite

Play Fit and fullscreen Fit were checked at:

- 1920×1080
- 1366×768
- 1024×768
- 820×1180
- 640×900

At all tested sizes the functional widgets remain inside the Fit frame, the frame remains inside the viewport, the title and toolbar do not overlap, and the controller frame starts below the fullscreen chrome even when the toolbar wraps.

## Intended workflow

### Build
Create/import → edit/arrange → optional Tidy → optional Trim Canvas → Fit Design or 1:1 for viewing → export.

### Play while disconnected
Play previews a snapshot of Build. Fit/1:1/zoom are view-only. Arrange → Done synchronizes explicit runtime geometry changes back to Build.

### Play while connected
Play shows only the verified firmware CFG. Arrange edits the runtime copy without silently overwriting Build; export it or explicitly load the device CFG into Build when desired.

## Firmware

No firmware behavior changed in this review. Existing **firmware v52** remains compatible; no reflash is required for v2.13.
