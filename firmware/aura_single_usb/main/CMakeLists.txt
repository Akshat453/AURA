# The CA certificate the device trusts: main/certs/ca.crt (copy data/device-tls/ca.crt
# from the assistant). Without it the build still succeeds with a placeholder so CI can
# compile the firmware, and the device refuses to start its network part.
if(EXISTS "${COMPONENT_DIR}/certs/ca.crt")
    set(ca_src "${COMPONENT_DIR}/certs/ca.crt")
else()
    message(WARNING "main/certs/ca.crt not found: embedding a placeholder (copy data/device-tls/ca.crt here)")
    set(ca_src "${COMPONENT_DIR}/certs/ca.example.crt")
endif()
set(ca_out "${CMAKE_BINARY_DIR}/aura_cert/ca.crt")
configure_file("${ca_src}" "${ca_out}" COPYONLY)

idf_component_register(SRCS "aura_single_usb.c"
                       INCLUDE_DIRS "."
                       EMBED_TXTFILES "${ca_out}")
