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

COPY build.sh /usr/local/bin/build.sh
COPY overlay /overlay
RUN chmod +x /usr/local/bin/build.sh

ENTRYPOINT ["/usr/local/bin/build.sh"]
CMD ["build"]
