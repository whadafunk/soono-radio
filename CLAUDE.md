# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Radio Automation and Streaming Server**: A complex application that provides radio station operators with an all-in-one platform to manage broadcasts. The system combines backend streaming infrastructure with a modern web-based control panel.

Core features include:
- Playlist management and scheduling
- Jingle organization and automation
- Real-time player controls
- Stream broadcasting via Icecast
- LiquidSoap integration for audio processing

## Technology Stack

The project uses a containerized architecture with these key components:

- **Icecast**: The streaming server for broadcasting audio to listeners
- **LiquidSoap**: Audio processing and automation engine
- **Docker/Docker Compose**: Container orchestration for development and deployment

**Deployment strategy**: Start with containerized development. Installable versions and Linux distro support can be added later without redesigning the core architecture.

## Architecture Overview

The application has two main components:

1. **Backend**: LiquidSoap audio engine with configuration/control interface
2. **Frontend**: Web-based graphical control panel for operators

Start with implementing LiquidSoap settings control panel, then expand to player, playlist, and jingle management.

## Implementation Notes

- Begin with container-based development (Docker Compose)
- Focus on core features before adding packaging complexity
- The frontend should provide intuitive control over LiquidSoap settings
- Design the API layer to support future extensibility
