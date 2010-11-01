/**
 * Services geometry node requests to store and render elements of geometry.
 *
 * Stores geometry in vertex buffers in video RAM, caching them there under a least-recently-used eviction policy
 * mediated by the "memory" backend.
 *
 * Geometry elements are identified by resource IDs, which may either be supplied by scene nodes, or automatically
 * generated by this backend.
 *
 * After creating geometry, the backend returns to the node the resource ID for the node to retain. The node
 * can then pass in the resource ID to test if the geometry still exists (perhaps it has been evicted) or to have the
 * backend render the geometry.
 *
 * The backend is free to evict whatever geometry it chooses between scene traversals, so the node must always check
 * the existence of the geometry and possibly request its re-creation each time before requesting the backend render it.
 *
 * A geometry buffer consists of positions, normals, optional texture coordinates, indices and a primitive type
 * (eg. "triangles").
 *
 * When rendering a geometry element, the backend will first fire a GEOMETRY_UPDATED to give the shader backend a
 * chance to prepare a shader script to render the geometry for current scene state. Then it will fire a SHADER_ACTIVATE
 * to prompt the shader backend to fire a SHADER_ACTIVATED to marshal resources from various backends (including this one)
 * for its shader script variables, which then provide their resources to the shader through XXX_EXPORTED events.
 * This backend then likewise provides its geometry buffers to the shader backend through a GEOMETRY_EXPORTED event,
 * then bind and draw the index buffer.
 *
 * The backend avoids needlessly re-exporting and re-binding geometry (eg. when rendering a bunch of cubes in a row)
 * by tracking the resource of the last geometry rendered. That resource is maintained until another either geoemetry is rendered,
 * the canvas switches, shader deactivates or scene deactivates.
 *
 *  @private

 */
SceneJS._geometryModule = new (function() {

    var time = (new Date()).getTime();  // For LRU caching
    var canvas;
    var geoMaps = {};                   // Geometry map for each canvas
    var currentGeoMap = null;
    var geoStack = [];

    SceneJS._eventModule.addListener(
            SceneJS._eventModule.TIME_UPDATED,
            function(t) {
                time = t;
            });

    SceneJS._eventModule.addListener(
            SceneJS._eventModule.SCENE_RENDERING,
            function() {
                canvas = null;
                currentGeoMap = null;
                geoStack = [];
            });

    SceneJS._eventModule.addListener(
            SceneJS._eventModule.CANVAS_ACTIVATED,
            function(c) {
                if (!geoMaps[c.canvasId]) {      // Lazy-create geometry map for canvas
                    geoMaps[c.canvasId] = {};
                }
                canvas = c;
                currentGeoMap = geoMaps[c.canvasId];
            });

    SceneJS._eventModule.addListener(
            SceneJS._eventModule.CANVAS_DEACTIVATED,
            function() {
                canvas = null;
                currentGeoMap = null;
            });

    SceneJS._eventModule.addListener(
            SceneJS._eventModule.SHADER_ACTIVATED,
            function() {
            });

    SceneJS._eventModule.addListener(
            SceneJS._eventModule.SHADER_DEACTIVATED,
            function() {
            });

    SceneJS._eventModule.addListener(
            SceneJS._eventModule.RESET,
            function() {
                for (var canvasId in geoMaps) {    // Destroy geometries on all canvases
                    var geoMap = geoMaps[canvasId];
                    for (var resource in geoMap) {
                        var geometry = geoMap[resource];
                        destroyGeometry(geometry);
                    }
                }
                canvas = null;
                geoMaps = {};
                currentGeoMap = null;
            });

    /**
     * Destroys geometry, returning true if memory freed, else false
     * where canvas not found and geometry was implicitly destroyed
     * @private
     */
    function destroyGeometry(geo) {
        //  SceneJS._loggingModule.debug("Destroying geometry : '" + geo.resource + "'");
        if (document.getElementById(geo.canvas.canvasId)) { // Context won't exist if canvas has disappeared
            if (geo.vertexBuf) {
                geo.vertexBuf.destroy();
            }
            if (geo.normalBuf) {
                geo.normalBuf.destroy();
            }
            if (geo.normalBuf) {
                geo.indexBuf.destroy();
            }
            if (geo.uvBuf) {
                geo.uvBuf.destroy();
            }
            if (geo.uvBuf2) {
                geo.uvBuf2.destroy();
            }
        }
        var geoMap = geoMaps[geo.canvas.canvasId];
        if (geoMap) {
            geoMap[geo.resource] = null;
        }
    }

    /**
     * Volunteer to attempt to destroy a geometry when asked to by memory module
     *
     */
    SceneJS._memoryModule.registerEvictor(
            function() {
                var earliest = time;
                var evictee;
                for (var canvasId in geoMaps) {
                    var geoMap = geoMaps[canvasId];
                    if (geoMap) {
                        for (var resource in geoMap) {
                            var geometry = geoMap[resource];
                            if (geometry) {
                                if (geometry.lastUsed < earliest
                                        && document.getElementById(geometry.canvas.canvasId)) { // Canvas must still exist
                                    evictee = geometry;
                                    earliest = geometry.lastUsed;
                                }
                            }
                        }
                    }
                }
                if (evictee) {
                    SceneJS._loggingModule.warn("Evicting geometry from memory: " + evictee.resource);
                    destroyGeometry(evictee);
                    return true;
                }
                return false;  // Couldnt find a geometry we can delete
            });

    /**
     * Creates an array buffer
     *
     * @private
     * @param context WebGL context
     * @param bufType Eg. ARRAY_BUFFER
     * @param values WebGL array
     * @param numItems
     * @param itemSize
     * @param usage Eg. STATIC_DRAW
     */
    function createArrayBuffer(description, context, bufType, values, numItems, itemSize, usage) {
        var buf;
        SceneJS._memoryModule.allocate(
                context,
                description,
                function() {
                    buf = new SceneJS._webgl_ArrayBuffer(context, bufType, values, numItems, itemSize, usage);
                });
        return buf;
    }

    /**
     * Converts SceneJS primitive type string to WebGL constant
     * @private
     */
    function getPrimitiveType(context, primitive) {
        switch (primitive) {
            case "points":
                return context.POINTS;
            case "lines":
                return context.LINES;
            case "line-loop":
                return context.LINE_LOOP;
            case "line-strip":
                return context.LINE_STRIP;
            case "triangles":
                return context.TRIANGLES;
            case "triangle-strip":
                return context.TRIANGLE_STRIP;
            case "triangle-fan":
                return context.TRIANGLE_FAN;
            default:
                throw SceneJS._errorModule.fatalError(new SceneJS.errors.InvalidNodeConfigException(// Logs and throws
                        "SceneJS.geometry primitive unsupported: '" +
                        primitive +
                        "' - supported types are: 'points', 'lines', 'line-loop', " +
                        "'line-strip', 'triangles', 'triangle-strip' and 'triangle-fan'"));
        }
    }


    /**
     * Tests if the given geometry resource exists on the currently active canvas
     * @private
     */
    this.testGeometryExists = function(resource) {
        return currentGeoMap[resource] ? true : false;
    };

    /**
     * Creates geometry on the active canvas - can optionally take a resource ID. On success, when ID given
     * will return that ID, else if no ID given, will return a generated one.
     * @private
     */
    this.createGeometry = function(resource, data) {
        if (!resource) {
            resource = SceneJS._createKeyForMap(currentGeoMap, "t");
        }

        //   SceneJS._loggingModule.debug("Creating geometry: '" + resource + "'");

        if (!data.primitive) { // "points", "lines", "line-loop", "line-strip", "triangles", "triangle-strip" or "triangle-fan"
            throw SceneJS._errorModule.fatalError(
                    new SceneJS.errors.NodeConfigExpectedException(
                            "SceneJS.geometry node property expected : primitive"));
        }
        var context = canvas.context;
        var usage = context.STATIC_DRAW;
        //var usage = (!data.fixed) ? context.STREAM_DRAW : context.STATIC_DRAW;

        var vertexBuf;
        var normalBuf;
        var uvBuf;
        var uvBuf2;
        var indexBuf;

        try { // TODO: Modify usage flags in accordance with how often geometry is evicted

            if (data.positions && data.positions.length > 0) {
                vertexBuf = createArrayBuffer("geometry vertex buffer", context, context.ARRAY_BUFFER,
                        new Float32Array(data.positions), data.positions.length, 3, usage);
            }

            if (data.normals && data.normals.length > 0) {
                normalBuf = createArrayBuffer("geometry normal buffer", context, context.ARRAY_BUFFER,
                        new Float32Array(data.normals), data.normals.length, 3, usage);
            }

            if (data.uv && data.uv.length > 0) {
                if (data.uv) {
                    uvBuf = createArrayBuffer("geometry UV buffer", context, context.ARRAY_BUFFER,
                            new Float32Array(data.uv), data.uv.length, 2, usage);
                }
            }

            if (data.uv2 && data.uv2.length > 0) {
                if (data.uv2) {
                    uvBuf2 = createArrayBuffer("geometry UV2 buffer", context, context.ARRAY_BUFFER,
                            new Float32Array(data.uv2), data.uv2.length, 2, usage);
                }
            }

            var primitive;
            if (data.indices && data.indices.length > 0) {
                primitive = getPrimitiveType(context, data.primitive);
                indexBuf = createArrayBuffer("geometry index buffer", context, context.ELEMENT_ARRAY_BUFFER,
                        new Uint16Array(data.indices), data.indices.length, 3, usage);
            }

            var geo = {
                fixed : true, // TODO: support dynamic geometry
                primitive: primitive,
                resource: resource,
                lastUsed: time,
                canvas : canvas,
                context : context,
                vertexBuf : vertexBuf,
                normalBuf : normalBuf,
                indexBuf : indexBuf,
                uvBuf: uvBuf,
                uvBuf2: uvBuf2                
            };
            currentGeoMap[resource] = geo;
            return resource;
        } catch (e) { // Allocation failure - delete whatever buffers got allocated

            if (vertexBuf) {
                vertexBuf.destroy();
            }
            if (normalBuf) {
                normalBuf.destroy();
            }
            if (uvBuf) {
                uvBuf.destroy();
            }
            if (uvBuf2) {
                uvBuf2.destroy();
            }
            if (indexBuf) {
                indexBuf.destroy();
            }
            throw e;
        }
    };

    this.pushGeometry = function(resource) {
        var geo = currentGeoMap[resource];
        geo.lastUsed = time;  // Geometry now not evictable during this scene traversal

        if (!geo.vertexBuf) {

            /* geometry has no vertex buffer - it must be therefore be indexing a vertex/uv buffers defined
             * by a higher Geometry, as part of a composite geometry:
             *
             * https://xeolabs.lighthouseapp.com/projects/50643/tickets/173-allow-mesh-as-one-vertex-geometry-and-multiple-index-geometrys
             *
             * It must therefore inherit the vertex buffer, along with UV coord buffers.
             *
             * We'll leave it to the render state graph traversal to ensure that the
             * vertex and UV buffers are not needlessly rebound for this geometry.
             */
            geo = inheritVertices(geo);
        }

        if (geo.indexBuf) {

            /* We don't render Geometry's that have no index buffer - they merely define
             * vertex/uv buffers that are indexed by sub-Geometry's in a composite geometry  
             */
            //            SceneJS._eventModule.fireEvent(
            //                    SceneJS._eventModule.GEOMETRY_EXPORTED,
            //                    geo);

            SceneJS._shaderModule.setGeometry(geo);
        }
        geoStack.push(geo);
    };

    function inheritVertices(geo) {
        var geo2 = {
            primitive: geo.primitive,
            normalBuf: geo.normalBuf,
            uvBuf: geo.uvBuf,
            uvBuf2: geo.uvBuf2,
            indexBuf: geo.indexBuf
        };
        for (var i = geoStack.length - 1; i >= 0; i--) {
            if (geoStack[i].vertexBuf) {
                geo2.vertexBuf = geoStack[i].vertexBuf;
                geo2.normalBuf = geoStack[i].normalBuf;
                geo2.uvBuf = geoStack[i].uvBuf;           // Vertex and UVs are a package
                geo2.uvBuf2 = geoStack[i].uvBuf2;
                return geo2;
            }
        }
        return geo2;
    }

    this.popGeometry = function() {
        geoStack.pop();
    };
})();
