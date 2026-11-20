# carlife-tap: the LD_PRELOAD library that copies CarLife's H.264 out of the
# projection process (src/tap.c). It builds in the unit's own ABI, as
# kit/renderd does: Ubuntu 18.04 has glibc 2.27, the same as the MGU, so the
# binary runs there unchanged.
#
#   make test     host build + the library's own behaviour (a process that
#                 preloads it must not change, and it must write its report)
#   make target   build and test in Docker, then copy the library to
#                 bin/libcarlife-tap.so, which is what the tool installs
#
# bin/ is committed: the Store packs the tool from the repository tree, so the
# binary has to be there before anyone can install it.

CC     ?= cc
CFLAGS ?= -O2 -g0 -Wall -Wextra -Werror -std=gnu11
BUILD  ?= build
JOBS   ?= $(shell nproc 2>/dev/null || echo 2)

IMAGE  := carlife-tap-build:$(shell cksum < docker/Dockerfile | cut -d' ' -f1)
DOCKER_IMAGE = docker image inspect $(IMAGE) >/dev/null 2>&1 || \
	docker build -q --platform linux/amd64 -t $(IMAGE) docker

T = $(BUILD)

.PHONY: all target test check clean bin

all: target

$(T)/libcarlife-tap.so: src/tap.c
	@mkdir -p $(@D)
	$(CC) $(CFLAGS) -fPIC -shared -o $@ src/tap.c

# The decoder. Plain C, its own dlopen of the unit's MSDK and libva, and the
# MSDK 1.x headers the unit's library takes (third_party/mfx, Intel MIT).
MFX = ../../third_party/mfx/include

$(T)/carlife-decode: src/decode.c
	@mkdir -p $(@D)
	$(CC) $(CFLAGS) -I$(MFX) -o $@ src/decode.c

# Named *carlife* on purpose: the library only reports inside a process whose
# executable is carlife's, and the test has to reach that path.
$(T)/carlife-tap-test: test/tap_test.c
	@mkdir -p $(@D)
	$(CC) $(CFLAGS) -o $@ test/tap_test.c

# Two streams, because the probe has two answers to get right: a stream with
# CarLife's headers around the picture, and one without. The second must be
# passed through exactly as 0.2 did.
test: $(T)/libcarlife-tap.so $(T)/carlife-tap-test
	rm -rf $(abspath $(T))/report.txt $(abspath $(T))/fake-usb
	CARLIFE_TAP_OUT=$(abspath $(T))/report.txt \
	CARLIFE_TAP_FAKE=$(abspath $(T))/fake-usb \
	LD_PRELOAD=$(abspath $(T))/libcarlife-tap.so $(T)/carlife-tap-test framed
	rm -rf $(abspath $(T))/report.txt $(abspath $(T))/fake-usb
	CARLIFE_TAP_OUT=$(abspath $(T))/report.txt \
	CARLIFE_TAP_FAKE=$(abspath $(T))/fake-usb \
	LD_PRELOAD=$(abspath $(T))/libcarlife-tap.so $(T)/carlife-tap-test raw
	$(MAKE) check

check: $(T)/libcarlife-tap.so $(T)/carlife-decode
	@echo "--- what the library must be ---"
	@file $(T)/libcarlife-tap.so
	@nm -D --defined-only $(T)/libcarlife-tap.so | grep -E ' T (read|ioctl)$$' || \
		{ echo "FAIL: read/ioctl are not exported"; exit 1; }
	@nm -D --undefined-only $(T)/libcarlife-tap.so | awk '{print $$2}' | sort -u | \
		sed 's/^/    needs /'
	@readelf -d $(T)/libcarlife-tap.so | grep NEEDED
	@objdump -T $(T)/libcarlife-tap.so | grep -o 'GLIBC_[0-9.]*' | sort -u | \
		sed 's/^/    requires /'

target:
	$(DOCKER_IMAGE)
	docker run --rm --platform linux/amd64 --user "$$(id -u):$$(id -g)" \
		-v "$(CURDIR):/w" -w /w $(IMAGE) make -s -j$(JOBS) BUILD=$(BUILD) test
	$(MAKE) bin

bin: $(T)/libcarlife-tap.so $(T)/carlife-decode
	@mkdir -p bin
	cp -f $(T)/libcarlife-tap.so bin/libcarlife-tap.so
	cp -f $(T)/carlife-decode bin/carlife-decode
	@chmod 0644 bin/libcarlife-tap.so
	@chmod 0755 bin/carlife-decode
	@ls -l bin/libcarlife-tap.so bin/carlife-decode

clean:
	rm -rf $(BUILD)
