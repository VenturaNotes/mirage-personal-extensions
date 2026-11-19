# ArchiveTasks

## Overview
ArchiveTasks is an extension for Mirage Editor that automatically extracts completed tasks from your active markdown notes and moves them into organized monthly archive files within your vault.

## Features
- Scans active Markdown notes for fully completed task trees (including nested subtasks).
- Automatically creates or appends to a designated monthly archive file (e.g., `(Archive) YYYY-MM.md`).
- Preserves note headers and document hierarchy during task migration.
- Safely updates editor content while preserving cursor positions and scroll states.

## Commands
- **Archive Completed Tasks** (`archive-tasks`): Scans the active Markdown file and archives all completed task trees.

## Usage
1. Open a Markdown note containing completed tasks (`- [x]`).
2. Open the command palette and run **Archive Completed Tasks**.
3. The extension strips the finished tasks from your note and appends them under the appropriate note title inside your configured monthly archive file.

## Configuration
- **Archive Folder**: Set the vault-relative folder path where monthly archive notes are saved (default: `Private/Archive`).