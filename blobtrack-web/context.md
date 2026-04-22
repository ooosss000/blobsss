# Blobsss - Project Context (v3.5)

## Project Overview
**Blobsss** is a high-performance 4K computer vision suite for real-time tracking and minimalist brutalist aesthetics, optimized for 1:1 native-resolution fidelity.

## Technical Context
- **Framework**: Vite + React + TypeScript.
- **Native Fidelity**: Automatically detects and matches input resolution (SOURCE).
- **Stall Protection**: 15Mbps bitrate + 1000ms chunking ensures robust 4K recording without frame loss.
- **Efficiency Mode**: Preview minimization (320px) during high-res recording.

## Render Modes
1.  **INVERT**: Pure geometry with `difference` text labels.
2.  **ASCII**: High-detail density mapped characters.
3.  **OUTLINE**: Clean soft-filled bounding boxes.
4.  **NET**: Centroid connectivity network.
5.  **GHOST**: Temporal motion tails.
6.  **ELLPS**: Concentric ellipses.
7.  **PATH**: Brighter monochrome video + point markers.

## Key Defaults (v3.5)
- **SOURCE QUALITY**: Automatic 1:1 match by default.
- **ENGINE**: strokeWidth: 1.5, fontSize: 13, neighborLinks: 3.
- **UI**: 11px Monospace / 1px Borders.
