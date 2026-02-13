# Cloudflare Workers Tests

This directory contains two Cloudflare Workers written in Rust:
- `stortinget-rss-worker`: Monitors RSS feed for new law proposals
- `stortinget-law-matcher`: Extracts and matches law references from proposals

## Running Tests Locally

### Prerequisites
- Rust toolchain (install via [rustup](https://rustup.rs/))
- Cargo (comes with Rust)

### Run All Tests

To run tests for both workers:

```bash
# From the repository root
cd workers/stortinget-rss-worker && cargo test --lib
cd ../stortinget-law-matcher && cargo test --lib
```

Or run them individually:

```bash
# Test RSS worker
cd workers/stortinget-rss-worker
cargo test --lib

# Test law matcher
cd workers/stortinget-law-matcher
cargo test --lib
```

### Test Coverage

#### stortinget-rss-worker
Tests cover:
- RSS feed parsing (valid/invalid/malformed XML)
- Date extraction from RSS items
- New item detection logic (comparing against last seen URL)
- Request ID generation and handling
- Edge cases (empty feeds, incomplete data)

#### stortinget-law-matcher
Tests cover:
- Law ID extraction from text (various formats, edge cases)
- Enforcement date parsing (fixed dates, "straks", "Kongen bestemmer", multiple dates)
- HTML extraction and cleaning
- Retry logic for failed fetches
- Norwegian month name mapping
- Date validation (including leap years)
- Text snippet extraction for logging
- Helper functions (truncation, character boundary clamping)

## CI/CD

### Continuous Integration
Tests run automatically on:
- Pull requests that modify `workers/**`
- Pushes to `master` branch

See `.github/workflows/workers-ci.yml` for the full CI configuration.

### Deployment
Workers are deployed to Cloudflare after tests pass:
- Tests run first in a separate job
- Deployment only proceeds if all tests pass
- See `.github/workflows/deploy-workers.yml` for deployment configuration

## Building for Production

To build workers for production:

```bash
# Install worker-build tool
cargo install worker-build@^0.7

# Build RSS worker
cd workers/stortinget-rss-worker
worker-build --release

# Build law matcher
cd ../stortinget-law-matcher
worker-build --release
```

## Test Organization

Tests are organized into modules for better clarity:

### stortinget-rss-worker
- Core parsing tests (RSS, dates)
- Request ID handling tests
- `new_item_detection` module: Tests for detecting new items vs. already-seen items

### stortinget-law-matcher
- Core extraction tests (law IDs, enforcement dates)
- `html_extraction` module: Tests for HTML parsing and cleaning
- `law_id_extraction` module: Tests for various law ID formats
- `enforcement_extraction` module: Tests for enforcement date patterns
- `retry_logic` module: Tests for fetch retry behavior
- `helper_functions` module: Tests for utility functions

## Adding New Tests

When adding new tests:
1. Keep tests focused and independent
2. Use descriptive test names that explain what is being tested
3. Group related tests into modules
4. Ensure tests run without external dependencies
5. Run locally before pushing: `cargo test --lib`
