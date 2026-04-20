---
name: deploy-container
description: "Builds Docker image, pushes to Docker Hub and Azure Container Registry using `scripts/deploy_containers.sh`. Use when you want to deploy container images from this repo."
---

Agent: Deploy Container Images

What it does:
- Builds the Docker image for this repository.
- Pushes the built image to Docker Hub (if `DOCKERHUB_USER` set).
- Pushes the built image to Azure Container Registry (if `ACR_NAME` set).

Usage:

1. Ensure Docker and Azure CLI are installed and you're logged in:

   - `docker login`
   - `az login`

2. Run with environment variables (example):

   ```bash
   IMAGE_NAME=stock-tracker IMAGE_TAG=latest \
     DOCKERHUB_USER=myhubuser DOCKERHUB_REPO=stock-tracker DOCKERHUB_TAG=latest \
     ACR_NAME=myacr ACR_REPO=stock-tracker ACR_TAG=latest \
     bash scripts/deploy_containers.sh
   ```

Notes and security:
- For CI, provide credentials via secrets and avoid embedding credentials in files.
- `az acr login` requires the Azure user to have push rights to the ACR or use a service principal.
