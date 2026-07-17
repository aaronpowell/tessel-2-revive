include $(TOPDIR)/rules.mk

PKG_NAME:=tessel-tools
PKG_VERSION:=0.1
PKG_RELEASE:=1

PKG_SOURCE_PROTO:=git
PKG_SOURCE_URL:=https://github.com/tessel/t2-firmware.git
PKG_SOURCE_SUBDIR:=$(PKG_NAME)-$(PKG_VERSION)
PKG_SOURCE_VERSION:=a22ba2d29e7e891c53fa6a4a26d5825b7d81d631
PKG_SOURCE:=$(PKG_NAME)-$(PKG_VERSION)-$(PKG_SOURCE_VERSION).tar.gz

include $(INCLUDE_DIR)/package.mk

define Package/tessel-tools
	CATEGORY:=Tessel
	TITLE:=Tessel coprocessor bridge (spid + usbexecd)
	DEPENDS:=+kmod-spi-dev
endef

define Package/tessel-tools/description
	SPI/USB bridge daemons that connect the MT7620 to the SAMD21 coprocessor.
	spid bridges the SPI bus to /var/run/tessel domain sockets; usbexecd accepts
	commands over USB. Built from tessel/t2-firmware soc/.
endef

# Drop -Werror so old-source warnings on newer toolchains don't fail the build.
# Force-include musl-stdio-fixup.h to undo musl's stdin/stdout/stderr macros,
# which collide with struct members / params of the same name in usbexecd.c.
define Build/Compile
	$(CP) ./files/musl-stdio-fixup.h $(PKG_BUILD_DIR)/soc/musl-stdio-fixup.h
	$(call Build/Compile/Default,-C soc CC="$(TARGET_CC)" CFLAGS="$(TARGET_CFLAGS) -std=c99 -Wall -include musl-stdio-fixup.h")
endef

define Package/tessel-tools/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_DIR) $(1)/etc/init.d

	$(INSTALL_BIN) $(PKG_BUILD_DIR)/soc/spid $(1)/usr/bin/spid
	$(INSTALL_BIN) ./files/spid-start $(1)/usr/bin/spid-start
	$(INSTALL_BIN) ./files/spid.init $(1)/etc/init.d/spid

	$(INSTALL_BIN) $(PKG_BUILD_DIR)/soc/usbexecd $(1)/usr/bin/usbexecd
	$(INSTALL_BIN) ./files/usbexecd-start $(1)/usr/bin/usbexecd-start
	$(INSTALL_BIN) ./files/usbexecd.init $(1)/etc/init.d/usbexecd
endef

$(eval $(call BuildPackage,tessel-tools))
