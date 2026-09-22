# Click-To-Deploy Tool & Dependency Manifest

## System Dependencies
- `gcloud` (version: >= 450.0.0) - Required to submit the container image build to Google Cloud Build (`gcloud builds submit`) during deployment.
- `git` (version: >= 2.30.0) - Fallback source checkout if the synced `/demo` directory is not present locally.

## Language Runtimes
- `nodejs` (version: >= 18.0.0) - Application runtime inside the Cloud Run container image (`Dockerfile`).
- `python3` (version: >= 3.10) - Used inside the container for Python task execution and WebAssembly game builds (`pygbag`).

## Package Dependencies
- `express` (npm) - HTTP server and NDJSON streaming API (`package.json`).
- `pygbag` (pip, inside container) - Compiles Pygame tasks (Super Mario, Pac-Man, Tetris) to WebAssembly.

## Environment Variables & Secrets
- `ADMIN_BOOTSTRAP_PASSWORD` - Secret (auto-generated via `random_password` in Terraform and stored in GCP Secret Manager).
- `AGENT_PLATFORM_API_KEY` - Secret (created in GCP Secret Manager; update via Secret Manager or supply per-session in the UI Settings drawer).
