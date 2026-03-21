# LLM Development Guidance

This document provides generic architectural and development guidelines for LLMs working on this software project. It is intended to serve as a guide to help you ensure consistency, quality, and maintainability when you are generating code for this project.

## Core Principles

### 1. Separation of Concerns
- Keep code well-separated, clean, and easy to maintain. This is a key architectural decision and should ALWAYS take priority over other things.
- Distinguish between different layers (e.g., presentation, business logic, data access, configuration).
- Encapsulate logic into meaningful domain objects, classes, or modules.
- UI components should focus on presentation, while business logic resides in services, hooks, or utility functions.
- The goal is to have a modular, easily changeable, well factored codebase that can be altered by either AI or humans without causing many side effects.

### 2. Simplicity and Iteration
- **Start Simple**: Begin with the simplest solution that works and refactor for complexity only when necessary.
- **Avoid Premature Optimization**: Focus on clarity and correctness first. You may suggest additional aspects you think should be done, but first suggest to the user. Do not add additional features or complexity without checking first.
- **YAGNI (You Ain't Gonna Need It)**: Do not implement features or abstractions before they are actually needed.

### 3. Code Reusability and Quality
- **DRY (Don't Repeat Yourself)**: Actively look for opportunities to reuse existing code, utilities, or patterns rather than duplicating logic.
- **Composition over Inheritance**: Prefer building complex behavior by combining simpler, focused parts.
- **Consistency**: Mimic existing patterns, naming conventions, and architectural choices within the codebase. If a pattern isn't working, alter the user and suggest changes to brainstorm ideas BEFORE making them.

## Architecture & Organization

### 1. Modular Design
- Create small, focused modules or components with a single, clear responsibility.
- Keep files concise and focused (aim for under 200-300 lines where practical).
- Organize files logically by feature or domain rather than just by technical type.

### 2. Configuration & Secrets
- Centralize configuration values and provide sensible defaults.
- Manage secrets and sensitive data (API keys, credentials) effectiely using hidden dot files and/or environment variables. NEVER READ THEM. Only suggest to the user how to add them and never take any steps that would reveal the secrets to you.
- Never hardcode environment-specific or sensitive information.

### 3. API & Contract Management
- Follow a **Contract-First** approach when possible, treating shared definitions or schemas as the source of truth.
- Maintain thin interfaces; delegate business logic to appropriate service or domain layers.
- Use standard protocols, status codes, and error formats consistently.

## Testing Strategy

### 1. Test-Driven Mindset
- Write small, fast-running unit tests for complex business logic, utility functions, and data transformations.
- Focus on testing **behavior and outcomes** rather than internal implementation details. Never write lots of tests that don't test significant logic, only write tests that are valiable and accomplish testing specific logic.
- Never write tests that test 3rd party libraries or their interfaces - these tests are not useful. Never write tests that simply test object creation or setting / getting variables.
- When making a new change, write failing integration or unit tests FIRST and then implement the change, running the test regularly, using it as your guide to see if you accomplished the change as expected or not.

### 2. Isolation and Speed
- Keep tests isolated from external dependencies (databases, third-party APIs) using mocks or stubs.
- Ensure the default test suite remains fast to encourage frequent execution during development.

### 3. Verification Workflow
- Run tests after every significant change to ensure no regressions were introduced.
- Differentiate between fast unit tests and slower, more expensive integration/E2E tests.

## Development Workflow

### 1. Pre-Implementation
- Understand the existing code structure and check for similar patterns.
- Consider if the change requires new tests or updates to existing ones - add or change these tests FIRST in such a way that they fail. Run them and ensure that they fail. THEN implement the change using this test to determine if you have successfully implemented them or not. However, ONLY write a test for a change if it tests significant logic and is legitimately useful.

### 2. Implementation
- Follow established code conventions (linting, type safety, naming).
- Keep functions and methods focused on a single responsibility.
- Add type safety wherever the language or environment permits.

### 3. Post-Implementation
- Verify changes with existing and new tests.
- Run project-specific quality checks (linting, building, type checking).
- Update relevant documentation if the public interface or behavior changed.

## Communication & Documentation

### 1. Code Documentation
- Do not add many comments. If you believe a comment is necessary, prefer making the code (e.g. function names or variable names) more readable first. Only add comments if they are absolutely necessary to document complex or non-obvious logic where the code itself cannot self-explain.

### 2. Commit Messages
- If you commit (only commit if asked by the user) provide concise, one-line summaries of changes.
- Add brief bullet points in the lines following the first main commit line which detail more details. Only do this when there are significant changes and only when necessary.
- Avoid mentioning trivial updates or boilerplate changes.

### 3. Error Handling
- Use structured logging to provide context for errors.
- Return meaningful, actionable error messages to users or calling systems.
- Catch and handle exceptions at the most appropriate architectural level.

