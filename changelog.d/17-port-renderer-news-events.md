- Move Protests & Crackdowns onto the renderer contract: its markers, clicks,
  ground height and horizon cull go through the renderer ports, and the layer
  no longer loads Cesium (roolio, #17).
