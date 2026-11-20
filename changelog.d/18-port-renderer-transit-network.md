- Move the Île-de-France Rail Network layer onto the renderer ports: its
  tracks and station dots are draw sets and its station heights go through
  the height service, so the layer no longer needs Cesium (roolio, #18).
