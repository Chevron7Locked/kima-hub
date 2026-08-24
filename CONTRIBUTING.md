# Contributing to Kima

First off, thanks for taking the time to contribute! 🎉

## Getting Started

1. Fork the repository
2. Clone your fork locally
3. Set up the development environment (see README.md)
4. Create a new branch from `main` for your changes

## Branch Strategy

All development happens on the `main` branch:

-   **All PRs should target `main`**
-   Preview images are built on demand, not on a schedule: push the `prerelease`
    branch, or run the **Pre-release Image** workflow from the Actions tab. They
    publish to this repository's GitHub Container Registry only
-   Stable releases are created via version tags, and those publish to Docker Hub

## Making Contributions

### Bug Fixes

1. Check existing issues to see if the bug has been reported
2. If not, open a bug report issue first
3. Fork, branch, fix, and submit a PR referencing the issue

### Small Enhancements

1. Open a feature request issue to discuss first
2. Keep changes focused and minimal

### Large Features

Please open an issue to discuss before starting work.

## Code Style

### Frontend

The frontend uses ESLint. Before submitting a PR:

```bash
cd frontend
npm run lint
```

### Backend

Follow existing code patterns and TypeScript conventions.

## Pull Request Process

1. **Target the `main` branch**
2. Fill out the PR template completely
3. Ensure the Docker build check passes
4. Wait for review - we'll provide feedback or approve

## Questions?

Open a Discussion thread for questions that aren't bugs or feature requests.

Thanks for contributing!
