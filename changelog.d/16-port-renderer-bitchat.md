- Port the Bitchat activity layer onto the renderer ports: its cells and
  outlines draw through the draw port and its clicks come through the input
  dispatcher, so it no longer loads Cesium (roolio, #16).
