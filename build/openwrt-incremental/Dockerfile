FROM ubuntu:18.04

ENV DEBIAN_FRONTEND=noninteractive
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8

# Build deps for OpenWrt 17.01 / 18.06 / 19.07 / 21.02 era buildroots.
# python (2) covers <=19.07; python3 + distutils are required from 21.02 (k5.4)
# onward, where the build system dropped Python 2 support.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash bison build-essential ca-certificates curl file flex gawk gettext \
      git-core less libncurses5-dev libncursesw5-dev libssl1.0-dev locales \
      patch perl python python-dev python3 python3-dev python3-distutils \
      python3-setuptools rsync subversion time unzip wget xsltproc \
      zlib1g-dev \
 && locale-gen en_US.UTF-8 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /work

# OpenWrt 23.05 (k5.15) toolchain bump: the bundled host tools (GNU M4 1.4.19,
# etc.) configure with `-std=gnu17`, which Ubuntu 18.04's default gcc 7.5 rejects
# ("C compiler cannot create executables" building tools/m4). gcc 8 is the first
# release to support c17/gnu17. Install gcc-8/g++-8 (available in the bionic
# archive) and make them the default host compiler via update-alternatives, so
# host-tool builds from 23.05 onward succeed. We stay on 18.04 (rather than
# bumping the base) to keep libssl1.0-dev and the exact package set that built
# the already-validated 17.01–22.03 hops; gcc-8 also builds those fine.
RUN apt-get update \
 && apt-get install -y --no-install-recommends gcc-8 g++-8 \
 && update-alternatives --install /usr/bin/gcc gcc /usr/bin/gcc-7 70 \
      --slave /usr/bin/g++ g++ /usr/bin/g++-7 \
 && update-alternatives --install /usr/bin/gcc gcc /usr/bin/gcc-8 80 \
      --slave /usr/bin/g++ g++ /usr/bin/g++-8 \
 && update-alternatives --set gcc /usr/bin/gcc-8 \
 && ln -sf /usr/bin/gcc /usr/bin/cc \
 && rm -rf /var/lib/apt/lists/* \
 && gcc --version | head -1 && g++ --version | head -1

# OpenWrt 24.10 (k6.6) host prereq: requires Python >= 3.7, but 18.04 ships 3.6.9
# as the default python3. 24.10's include/prereq-build.mk SetupHostCommand probes
# candidate interpreters BY VERSIONED NAME (python3.7 .. python3.12) and symlinks
# the first one it finds into staging_dir/host/bin/python3, so we only need
# python3.7 to EXIST by name — we deliberately do NOT repoint the default
# python/python3. That keeps python2-as-`python` and python3.6 intact for the
# already-validated <=19.07 hops (which expect them), while 24.10+ transparently
# picks up python3.7. bionic universe ships python3.7 (3.7.5); python3.7-distutils
# satisfies the prereq's distutils/stdlib checks (run via staging_dir/host/bin).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3.7 python3.7-dev python3.7-distutils \
 && rm -rf /var/lib/apt/lists/* \
 && python3.7 --version

COPY build.sh /usr/local/bin/build.sh
COPY overlay /overlay
RUN chmod +x /usr/local/bin/build.sh

ENTRYPOINT ["/usr/local/bin/build.sh"]
CMD ["build"]
