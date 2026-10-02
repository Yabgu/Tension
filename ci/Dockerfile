# Tension development / CI image (Arch Linux).
#
# Build context is ci/ (see ci/docker.sh build), so the locally built
# OGRE-Next packages live next to this file in ci/ogre-next-pkg/.
FROM archlinux:base-devel

# Base toolchain + headless graphics stack for the test suites.
RUN pacman -Syu --noconfirm && \
    pacman -S --noconfirm \
        zig \
        rustup \
        nodejs \
        npm \
        xorg-server-xvfb \
        mesa \
        libglvnd \
        vulkan-swrast \
        vulkan-icd-loader \
        vulkan-headers \
        vulkan-tools \
        git \
        pkg-config \
        alsa-lib \
        gcc-fortran \
        clang \
        cmake

# OGRE-Next and its freeimage dependency, built locally (see ci/README.md).
COPY ogre-next-pkg/*.pkg.tar.zst /tmp/
RUN pacman -U --noconfirm /tmp/*.pkg.tar.zst && rm /tmp/*.pkg.tar.zst

# Rust toolchain. Installed under /opt so root (CI runs) and the dev user
# share a single toolchain.
ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo
RUN rustup toolchain install stable && rustup default stable

# Non-root user for development: files written into a bind-mounted checkout
# stay owned by the host user (ci/docker.sh dev runs as this user).
RUN useradd -m -u 1000 dev && \
    mkdir -p /opt/cargo && chown -R dev:dev /opt/rustup /opt/cargo

# Headless rendering: every command runs under Xvfb with software GL and
# lavapipe. Override these when running on a machine with a GPU.
ENV DISPLAY=:99
ENV LIBGL_ALWAYS_SOFTWARE=1
ENV VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.x86_64.json

WORKDIR /app

ENTRYPOINT ["xvfb-run", "-a", "--"]
CMD ["bash"]
