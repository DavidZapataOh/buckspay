cmake_minimum_required(VERSION 3.22.1)
project(copresence LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -fvisibility=hidden -fno-exceptions -fno-rtti -ffunction-sections -fdata-sections")

add_library(copresence SHARED copresence_jni.cpp ggwave/ggwave.cpp)
set_source_files_properties(ggwave/ggwave.cpp PROPERTIES COMPILE_OPTIONS "-w")
target_include_directories(copresence PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
target_link_options(copresence PRIVATE -Wl,--gc-sections)
target_link_libraries(copresence PRIVATE log)
