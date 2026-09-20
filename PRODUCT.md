# 墨生万象 / Inkborne

<!-- impeccable:product-schema 1 -->

## Platform

web

React UI inside a Windows Electron desktop shell; no mobile distribution in this task.

## Purpose

A Windows desktop application for personal, local novel writing. Electron hosts the forked InkOS studio and core. The author works on real local manuscripts, not a commercial social platform.

## Authoring mechanism

Four stages drive a novel: 问心 discusses the story and prepares the canon; 研墨 generates and refines settings; 织卷 plans the story outline and chapter summaries; 落笔 writes chapters from the preceding adopted material.

Each stage has independent creation and review model configuration (eight slots total). Generation produces a candidate; saving, reviewing and adopting remain distinct. Adopted material must not change without explicit adoption. Reports refer to the version reviewed.

## Current redesign brief

The user completed a detailed interview on 2026-09-16 and authorized implementation. See `docs/水墨UI方案-Fable51-视觉与信息架构清理-97a2b73.md`.

The desired interface is quiet Chinese ink: calligraphic stage names, Song-style manuscript typography, near-white day paper with selectable paper colors, charcoal night paper. Small ink decorations occur only in unused space. Retain the existing logo. Do not copy a reference app's unrelated features.

Ask is conversation-first with a collapsible canon. Ground and Weave have no conversation area; manuscripts and catalogs lead. Write uses a collapsible chapter list. All manuscripts are read-only until Edit. Review occupies a collapsible right panel. Edit, Review and Adopt remain direct actions; regeneration and versions are secondary actions.

Zero books opens author/name and the first-book invitation; one book resumes its last stage; multiple books opens the cover bookshelf. Author identity persists across books. Global import, model configuration, theme and previous extra tools converge under one configuration entry. Existing capabilities remain reachable without duplicate prominent entries.

## Platform and boundaries

Platform: Windows Electron desktop, approximately 1480×960 standard and 1100×720 minimum window. Explicit project root and shell-managed engine port. Preserve AGPL notices, current local data, credentials, existing edits and core workflow. No old Next.js or separate browser manuscript database.

The user will perform page-by-page desktop acceptance. Use bounded source/type/build checks and do not resume slow unattended control-by-control UI automation without user direction. Never label a build or unit test as full visual or real-model acceptance.
