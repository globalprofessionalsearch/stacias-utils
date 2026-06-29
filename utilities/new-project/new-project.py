#!/usr/bin/env python3
# ============================================================
# new-project.py — iTerm2 project workspace provisioner
# ============================================================

import iterm2
import sys
import os
import math
import hashlib
import struct
import zlib
import tempfile
import subprocess
import threading
import time

def usage():
    print("Usage: new-project <project-name>")
    print("  Opens iTerm2 workspace centered on current directory")
    print("  Example: new-project my-api")
    sys.exit(1)

# ── Deterministic random ──────────────────────────────────────

def srand(seed, index):
    h = hashlib.md5(f"{seed}:{index}".encode()).hexdigest()
    return int(h[:8], 16) / 0xFFFFFFFF

# ── Project color palette ─────────────────────────────────────
#
# Each anchor is the "identity color" for one project scheme, as an
# (hue, saturation, lightness) triple in HSL:
#   hue:        0-360   the color itself (0/360=red, 120=green, 240=blue)
#   saturation: 0-100   keep high (~50-70) so the color reads as bold
#   lightness:  0-100   keep low (~8-14) so terminal text stays readable
#
# These are BASE-FIELD values — the whole window is tinted with them, and
# the vivid blob/wave pools are derived from each anchor's hue at render time.
#
# select_scheme() maps a project name onto one of these deterministically,
# so the same name always gets the same scheme with no stored state.
#
# TODO(you): flesh this out to ~10-12 well-separated anchors so a handful of
# projects are obviously distinct at a glance. Four starters are here so the
# script runs today — pick hues spread around the wheel (the bigger the gap
# between any two hues, the more distinct the projects). Tune sat/light to taste.
ANCHORS = [
    (183, 68, 11),   # deep teal
    ( 28, 62, 12),   # burnt amber
    (275, 55, 12),   # plum
    (101, 33,  4),   # forest
    (245, 75, 12),   # indigo
    # TODO: add a few more anchors to reduce same-hue collisions across projects
]

def select_scheme(project_name):
    """Deterministically pick one anchor (hue, sat, light) for a project name."""
    idx = int(srand(project_name, 9001) * len(ANCHORS)) % len(ANCHORS)
    return ANCHORS[idx]

# ── Color helpers ─────────────────────────────────────────────

def hsl_to_rgb(h, s, l):
    h /= 360; s /= 100; l /= 100
    if s == 0:
        v = int(l * 255)
        return (v, v, v)
    def hue2rgb(p, q, t):
        if t < 0: t += 1
        if t > 1: t -= 1
        if t < 1/6: return p + (q - p) * 6 * t
        if t < 1/2: return q
        if t < 2/3: return p + (q - p) * (2/3 - t) * 6
        return p
    q = l * (1 + s) if l < 0.5 else l + s - l * s
    p = 2 * l - q
    return (int(hue2rgb(p, q, h + 1/3) * 255),
            int(hue2rgb(p, q, h) * 255),
            int(hue2rgb(p, q, h - 1/3) * 255))

# ── Perlin noise generator ───────────────────────────────────

def generate_perlin_noise(seed, width, height, base_hue, base_sat, base_light):
    """Generate background with Perlin noise (smooth, cloud-like patterns)."""
    
    # Grid dimensions for gradient vectors
    grid_size = 8
    cell_width = width / grid_size
    cell_height = height / grid_size
    
    # Generate deterministic gradient vectors at each grid point
    gradients = {}
    for gy in range(grid_size + 1):
        for gx in range(grid_size + 1):
            # Use srand for deterministic angles
            angle = srand(seed, gx * 1000 + gy * 100) * 2 * math.pi
            gradients[(gx, gy)] = (math.cos(angle), math.sin(angle))
    
    def smoothstep(t):
        """Smoothstep interpolation for smooth gradients."""
        return t * t * (3 - 2 * t)
    
    def lerp(a, b, t):
        """Linear interpolation."""
        return a + t * (b - a)
    
    def dot_grid_gradient(gx, gy, x, y):
        """Calculate dot product between gradient and distance vectors."""
        grad = gradients.get((gx, gy), (0, 0))
        dx = x - gx * cell_width
        dy = y - gy * cell_height
        return grad[0] * dx + grad[1] * dy
    
    def perlin(x, y):
        """Calculate Perlin noise value at pixel (x, y)."""
        # Determine grid cell
        x0 = int(x / cell_width)
        y0 = int(y / cell_height)
        x1 = x0 + 1
        y1 = y0 + 1
        
        # Interpolation weights
        sx = (x / cell_width) - x0
        sy = (y / cell_height) - y0
        
        # Smooth the weights
        sx = smoothstep(sx)
        sy = smoothstep(sy)
        
        # Dot products at corners
        n0 = dot_grid_gradient(x0, y0, x, y)
        n1 = dot_grid_gradient(x1, y0, x, y)
        ix0 = lerp(n0, n1, sx)
        
        n0 = dot_grid_gradient(x0, y1, x, y)
        n1 = dot_grid_gradient(x1, y1, x, y)
        ix1 = lerp(n0, n1, sx)
        
        # Final interpolation
        value = lerp(ix0, ix1, sy)
        return value
    
    # Generate pixels with Perlin noise
    pixels = []
    
    # Pre-calculate noise values to find min/max for normalization
    noise_values = []
    for y in range(height):
        row = []
        for x in range(width):
            # Sample at multiple octaves for more detail
            noise = 0
            noise += perlin(x * 1.0, y * 1.0) * 1.0      # Base octave
            noise += perlin(x * 2.0, y * 2.0) * 0.5      # Higher frequency
            noise += perlin(x * 4.0, y * 4.0) * 0.25     # Even higher
            row.append(noise)
        noise_values.append(row)
    
    # Normalize noise to 0-1 range
    flat_noise = [n for row in noise_values for n in row]
    min_noise = min(flat_noise)
    max_noise = max(flat_noise)
    noise_range = max_noise - min_noise if max_noise != min_noise else 1.0
    
    # Convert noise to colors
    for y in range(height):
        for x in range(width):
            # Normalized noise value 0-1
            noise = (noise_values[y][x] - min_noise) / noise_range
            
            # Vary hue ±30° based on noise, keeping cloud-like variation
            hue = (base_hue + (noise - 0.5) * 60) % 360
            
            # Keep saturation similar to base
            sat = base_sat + (noise - 0.5) * 20  # Slight variation
            sat = max(30, min(80, sat))
            
            # Keep lightness dark for terminal readability (8-20 range)
            light = 8 + noise * 12  # Maps 0-1 noise to 8-20 lightness
            
            # Add some cloud-like structure by emphasizing certain noise values
            if noise > 0.6:
                light += (noise - 0.6) * 15  # Brighter "cloud peaks"
            
            light = max(8, min(20, light))
            
            r, g, b = hsl_to_rgb(hue, sat, light)
            pixels.append((r, g, b))
    
    return pixels

def generate_topographic(seed, width, height, base_hue, base_sat, base_light):
    """Generate background with topographic contour lines (elevation map style)."""
    
    # Generate 3-5 sine waves with random parameters
    num_waves = 3 + int(srand(seed, 2000) * 3)  # 3-5 waves
    waves = []
    
    for i in range(num_waves):
        # Frequency: how many cycles across the image (0.5 to 3.0)
        frequency = 0.5 + srand(seed, 2100 + i) * 2.5
        
        # Direction angle: which way the wave travels (0 to 2π)
        angle = srand(seed, 2200 + i) * 2 * math.pi
        
        # Phase offset: shifts the wave pattern
        phase = srand(seed, 2300 + i) * 2 * math.pi
        
        # Amplitude: contribution strength (0.3 to 1.0)
        amplitude = 0.3 + srand(seed, 2400 + i) * 0.7
        
        waves.append((frequency, angle, phase, amplitude))
    
    # Calculate height field for all pixels
    height_field = []
    for y in range(height):
        row = []
        for x in range(width):
            # Sum contributions from all waves
            total_height = 0
            for freq, angle, phase, amp in waves:
                # Project x,y onto wave direction
                # This creates diagonal wave patterns
                t = freq * (x * math.cos(angle) + y * math.sin(angle)) / max(width, height)
                wave_value = math.sin(2 * math.pi * t + phase)
                total_height += amp * wave_value
            row.append(total_height)
        height_field.append(row)
    
    # Normalize height field to 0-1 range
    flat_heights = [h for row in height_field for h in row]
    min_h = min(flat_heights)
    max_h = max(flat_heights)
    height_range = max_h - min_h if max_h != min_h else 1.0
    
    normalized_heights = []
    for row in height_field:
        normalized_row = [(h - min_h) / height_range for h in row]
        normalized_heights.append(normalized_row)
    
    # Number of contour levels (more = denser lines)
    num_levels = 15 + int(srand(seed, 2500) * 10)  # 15-24 levels
    level_spacing = 1.0 / num_levels
    
    # Line thickness in pixels
    line_thickness = 1.0 + srand(seed, 2600) * 1.0  # 1-2 pixels
    
    # Generate pixels with contour lines
    pixels = []
    
    for y in range(height):
        for x in range(width):
            h = normalized_heights[y][x]
            
            # Find which contour level this pixel is closest to
            level = h / level_spacing
            distance_to_line = abs(level - round(level)) * level_spacing
            
            # Convert distance from normalized space to pixel space
            # (approximate, assuming relatively uniform gradient)
            distance_pixels = distance_to_line * max(width, height) / num_levels
            
            # Check if we're on or near a contour line
            if distance_pixels < line_thickness:
                # On a contour line - make it brighter
                # Fade from full brightness at center to background at edges
                line_factor = 1.0 - (distance_pixels / line_thickness)
                line_factor = line_factor * line_factor  # Smooth curve
                
                # Line color: slightly brighter and with hue variation by elevation
                elevation_level = int(round(level))
                line_hue = (base_hue + (elevation_level % 5 - 2) * 5) % 360  # ±10° variation
                line_sat = base_sat * 0.9
                line_light = 15 + line_factor * 10  # 15-25 lightness range
                
                # Background color: dark
                bg_light = 8 + h * 4  # 8-12 lightness, subtle elevation shading
                
                # Blend line with background based on line_factor
                r_line, g_line, b_line = hsl_to_rgb(line_hue, line_sat, line_light)
                r_bg, g_bg, b_bg = hsl_to_rgb(base_hue, base_sat * 0.7, bg_light)
                
                r = int(r_line * line_factor + r_bg * (1 - line_factor))
                g = int(g_line * line_factor + g_bg * (1 - line_factor))
                b = int(b_line * line_factor + b_bg * (1 - line_factor))
            else:
                # Away from contour lines - use dark background with subtle elevation shading
                bg_hue = base_hue
                bg_sat = base_sat * 0.7
                bg_light = 8 + h * 4  # 8-12 lightness, varies slightly with elevation
                
                r, g, b = hsl_to_rgb(bg_hue, bg_sat, bg_light)
            
            pixels.append((r, g, b))
    
    return pixels

def generate_constellation(seed, width, height, base_hue, base_sat, base_light):
    """Generate background with constellation/network (dots connected by lines)."""
    # Place 30-50 points randomly
    num_points = 30 + int(srand(seed, 8000) * 21)  # 30-50 points
    points = []
    for i in range(num_points):
        px = srand(seed, 9000 + i * 2) * width
        py = srand(seed, 9000 + i * 2 + 1) * height
        points.append((px, py))
    
    # Connection threshold: closer points get connected
    # Use percentage of screen diagonal for responsive threshold
    diagonal = math.sqrt(width * width + height * height)
    connection_threshold = diagonal * 0.15  # Connect if within 15% of diagonal
    
    # Build connection list (point pairs within threshold)
    connections = []
    for i in range(len(points)):
        for j in range(i + 1, len(points)):
            px1, py1 = points[i]
            px2, py2 = points[j]
            dx = px2 - px1
            dy = py2 - py1
            dist = math.sqrt(dx * dx + dy * dy)
            if dist < connection_threshold:
                connections.append((i, j, dist))
    
    # Initialize pixels with dark base (lightness 8-12)
    base_light_dark = 8 + srand(seed, 8500) * 4  # 8-12
    bg_r, bg_g, bg_b = hsl_to_rgb(base_hue, base_sat, base_light_dark)
    pixels = [(bg_r, bg_g, bg_b)] * (width * height)
    
    # Helper: draw line with anti-aliasing using Xiaolin Wu's algorithm (simplified)
    def draw_line(x0, y0, x1, y1, color, alpha_base):
        """Draw anti-aliased line with given base alpha."""
        dx = abs(x1 - x0)
        dy = abs(y1 - y0)
        
        # Handle steep lines
        steep = dy > dx
        if steep:
            x0, y0 = y0, x0
            x1, y1 = y1, x1
            dx, dy = dy, dx
        
        if x0 > x1:
            x0, x1 = x1, x0
            y0, y1 = y1, y0
        
        gradient = dy / dx if dx != 0 else 0
        y = y0
        
        for x in range(int(x0), int(x1) + 1):
            # Calculate alpha with distance falloff
            alpha = alpha_base * 0.3  # Make lines subtle
            
            # Plot pixel
            px = int(y if steep else x)
            py = int(x if steep else y)
            
            if 0 <= px < width and 0 <= py < height:
                idx = py * width + px
                r_bg, g_bg, b_bg = pixels[idx]
                r_fg, g_fg, b_fg = color
                
                # Blend with alpha
                r = int(r_fg * alpha + r_bg * (1 - alpha))
                g = int(g_fg * alpha + g_bg * (1 - alpha))
                b = int(b_fg * alpha + b_bg * (1 - alpha))
                pixels[idx] = (r, g, b)
            
            y += gradient
    
    # Helper: draw circle with glow
    def draw_point(cx, cy, radius, color, glow_radius):
        """Draw point with soft glow."""
        for dy in range(-glow_radius, glow_radius + 1):
            for dx in range(-glow_radius, glow_radius + 1):
                px = int(cx) + dx
                py = int(cy) + dy
                
                if 0 <= px < width and 0 <= py < height:
                    dist = math.sqrt(dx * dx + dy * dy)
                    
                    # Core circle: full brightness within radius
                    if dist <= radius:
                        alpha = 0.9
                    # Glow: falloff from radius to glow_radius
                    elif dist <= glow_radius:
                        falloff = (glow_radius - dist) / (glow_radius - radius)
                        alpha = 0.6 * falloff * falloff  # Quadratic falloff for soft glow
                    else:
                        continue
                    
                    idx = py * width + px
                    r_bg, g_bg, b_bg = pixels[idx]
                    r_fg, g_fg, b_fg = color
                    
                    r = int(r_fg * alpha + r_bg * (1 - alpha))
                    g = int(g_fg * alpha + g_bg * (1 - alpha))
                    b = int(b_fg * alpha + b_bg * (1 - alpha))
                    pixels[idx] = (r, g, b)
    
    # Draw connections (lines) first, then points on top
    # Line color: lighter than background (lightness 20-25)
    line_light = 20 + srand(seed, 8600) * 5  # 20-25
    line_r, line_g, line_b = hsl_to_rgb(base_hue, base_sat * 0.7, line_light)
    
    for i, j, dist in connections:
        px1, py1 = points[i]
        px2, py2 = points[j]
        
        # Alpha falloff: closer connections are more opaque
        alpha = 1.0 - (dist / connection_threshold)
        alpha = alpha * alpha  # Quadratic falloff for smoother appearance
        
        draw_line(px1, py1, px2, py2, (line_r, line_g, line_b), alpha)
    
    # Draw points (nodes) with glow
    # Point color: brighter than lines (lightness 28-35)
    point_light = 28 + srand(seed, 8700) * 7  # 28-35
    point_r, point_g, point_b = hsl_to_rgb(base_hue, base_sat * 0.8, point_light)
    
    # Scale point size with screen size
    point_radius = max(1, int(width * 0.003))  # ~3 pixels at 1920px
    glow_radius = max(3, int(width * 0.008))   # ~8 pixels at 1920px
    
    for px, py in points:
        draw_point(px, py, point_radius, (point_r, point_g, point_b), glow_radius)
    
    return pixels

def generate_tessellation(seed, width, height, base_hue, base_sat, base_light):
    """Generate background with geometric tessellation (hexagons)."""
    # Hexagonal tessellation using axial coordinates
    # Hexagon size in pixels (radius from center to vertex)
    hex_size = 40 + int(srand(seed, 8000) * 30)  # 40-70 pixels
    
    # Hexagon geometry constants
    # For flat-top hexagons:
    hex_width = hex_size * 2
    hex_height = math.sqrt(3) * hex_size
    
    # Horizontal and vertical spacing between hex centers
    horiz_spacing = hex_width * 0.75  # 3/4 width
    vert_spacing = hex_height
    
    # Calculate how many hexagons we need to cover the canvas
    cols = int(width / horiz_spacing) + 3
    rows = int(height / vert_spacing) + 3
    
    # Generate color for each hexagon
    hex_colors = {}
    for row in range(-2, rows + 2):
        for col in range(-2, cols + 2):
            # Each hex gets a hue variation ±20° from base
            hue_offset = (srand(seed, 9000 + row * 1000 + col) * 40 - 20)
            hex_hue = (base_hue + hue_offset) % 360
            
            # Lightness variation 8-16 for readability
            lightness = 8 + srand(seed, 10000 + row * 1000 + col) * 8
            
            # Saturation slight variation around base
            sat = base_sat + (srand(seed, 11000 + row * 1000 + col) * 20 - 10)
            sat = max(40, min(70, sat))
            
            hex_colors[(row, col)] = hsl_to_rgb(hex_hue, sat, lightness)
    
    def hex_to_pixel(row, col):
        """Convert hexagon axial coordinates to pixel center position."""
        x = col * horiz_spacing
        # Offset every other column for hexagonal packing
        y = row * vert_spacing + (vert_spacing / 2 if col % 2 == 1 else 0)
        return x, y
    
    def pixel_to_hex(x, y):
        """Find which hexagon contains the pixel at (x, y)."""
        # Approximate column
        col = int(x / horiz_spacing)
        
        # Calculate y offset based on column parity
        y_offset = vert_spacing / 2 if col % 2 == 1 else 0
        row = int((y - y_offset) / vert_spacing)
        
        # Check this hex and neighbors to find the closest one
        candidates = []
        for dr in range(-1, 2):
            for dc in range(-1, 2):
                test_row = row + dr
                test_col = col + dc
                cx, cy = hex_to_pixel(test_row, test_col)
                dist_sq = (x - cx) ** 2 + (y - cy) ** 2
                candidates.append((dist_sq, test_row, test_col))
        
        # Return the closest hexagon
        candidates.sort()
        return candidates[0][1], candidates[0][2]  # row, col
    
    def distance_to_hex_edge(x, y, hex_row, hex_col):
        """Calculate distance from pixel to nearest edge of its hexagon."""
        cx, cy = hex_to_pixel(hex_row, hex_col)
        dx = x - cx
        dy = y - cy
        
        # For a flat-top hexagon, check distance to edges
        # Using approximate distance based on radial distance
        dist_from_center = math.sqrt(dx * dx + dy * dy)
        
        # The inscribed circle radius (distance to flat edges)
        edge_dist = hex_size * math.sqrt(3) / 2
        
        # Approximate distance to edge
        return edge_dist - dist_from_center
    
    # Generate pixels
    pixels = []
    
    for y in range(height):
        for x in range(width):
            # Find which hexagon this pixel belongs to
            hex_row, hex_col = pixel_to_hex(x, y)
            
            # Get the base color for this hexagon
            r, g, b = hex_colors.get((hex_row, hex_col), (20, 20, 20))
            
            # Calculate distance to edge for border effect
            edge_dist = distance_to_hex_edge(x, y, hex_row, hex_col)
            
            # Draw subtle borders (darken pixels near edges)
            border_width = 2.0  # pixels
            if edge_dist < border_width:
                # Gradually darken as we approach the edge
                darken_factor = max(0.5, edge_dist / border_width)
                r = int(r * darken_factor)
                g = int(g * darken_factor)
                b = int(b * darken_factor)
            
            pixels.append((r, g, b))
    
    return pixels

def generate_fourier_harmonics(seed, width, height, base_hue, base_sat, base_light):
    """Generate background with Fourier harmonics (interference patterns)."""
    # Algorithm:
    # 1. Sum 4-6 2D sine waves at different frequencies/angles
    # 2. Each wave: sin(freq_x * x + phase_x) * sin(freq_y * y + phase_y)
    # 3. Use interference pattern to determine color
    # 4. Map pattern value to hue variation (base_hue ± 30°)
    # 5. Keep dark (lightness 8-16) with brighter interference peaks (20-30)
    
    # Generate 4-6 harmonic waves with random parameters
    num_waves = 4 + int(srand(seed, 3000) * 3)  # 4-6 waves
    waves = []
    
    for i in range(num_waves):
        # Frequency components for x and y directions
        # Keep frequencies low (0.5 - 3.0) for smooth, organic patterns
        freq_x = 0.5 + srand(seed, 4000 + i * 10) * 2.5  # 0.5 - 3.0
        freq_y = 0.5 + srand(seed, 4001 + i * 10) * 2.5  # 0.5 - 3.0
        
        # Phase offsets for each direction (0 to 2π)
        phase_x = srand(seed, 4002 + i * 10) * 2 * math.pi
        phase_y = srand(seed, 4003 + i * 10) * 2 * math.pi
        
        # Amplitude: contribution strength (0.4 to 1.0)
        amplitude = 0.4 + srand(seed, 4004 + i * 10) * 0.6
        
        waves.append((freq_x, freq_y, phase_x, phase_y, amplitude))
    
    # Calculate interference pattern for all pixels
    interference_values = []
    
    for y in range(height):
        row = []
        for x in range(width):
            # Normalize coordinates to 0-1 range
            nx = x / max(width, height)
            ny = y / max(width, height)
            
            # Sum all harmonic contributions
            total = 0
            for freq_x, freq_y, phase_x, phase_y, amplitude in waves:
                # 2D sine wave: sin(freq_x * x + phase_x) * sin(freq_y * y + phase_y)
                wave_x = math.sin(freq_x * 2 * math.pi * nx + phase_x)
                wave_y = math.sin(freq_y * 2 * math.pi * ny + phase_y)
                total += amplitude * wave_x * wave_y
            
            row.append(total)
        interference_values.append(row)
    
    # Normalize interference pattern to 0-1 range
    flat_values = [v for row in interference_values for v in row]
    min_val = min(flat_values)
    max_val = max(flat_values)
    val_range = max_val - min_val if max_val != min_val else 1.0
    
    normalized = []
    for row in interference_values:
        normalized_row = [(v - min_val) / val_range for v in row]
        normalized.append(normalized_row)
    
    # Generate pixels with subtle color mapping
    pixels = []
    
    for y in range(height):
        for x in range(width):
            # Get normalized interference value (0-1)
            pattern_value = normalized[y][x]
            
            # Map pattern to hue variation (base_hue ± 30°)
            # Center pattern around base_hue for organic color flow
            hue_offset = (pattern_value - 0.5) * 60  # ±30°
            hue = (base_hue + hue_offset) % 360
            
            # Keep saturation moderate and consistent for subtlety
            sat = base_sat * 0.75  # Slightly desaturate for elegance
            
            # Map lightness: dark base (8-16) with brighter peaks (20-30)
            # Use quadratic mapping for emphasis on bright spots
            if pattern_value > 0.6:
                # Bright interference peaks
                peak_factor = (pattern_value - 0.6) / 0.4  # 0-1 for values 0.6-1.0
                light = 16 + peak_factor * 14  # 16-30
            else:
                # Dark background with subtle variation
                light = 8 + pattern_value * 8  # 8-16
            
            # Add subtle contrast enhancement at extreme interference
            # This creates more visible structure
            if pattern_value < 0.15 or pattern_value > 0.85:
                contrast_boost = abs(pattern_value - 0.5) * 2  # 0.7-1.0
                sat = min(100, sat * (1 + contrast_boost * 0.3))
            
            # Clamp values
            sat = max(20, min(90, sat))
            light = max(8, min(30, light))
            
            r, g, b = hsl_to_rgb(hue, sat, light)
            pixels.append((r, g, b))
    
    return pixels

# ── Pure-Python PNG writer ────────────────────────────────────

def write_png(pixels, width, height, path):
    def chunk(name, data):
        c = name + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
    raw = b''
    for y in range(height):
        row = b'\x00'
        for x in range(width):
            r, g, b = pixels[y * width + x]
            row += bytes([r, g, b])
        raw += row
    png  = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw, 6))
    png += chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)

# ── Screen bounds of the screen containing iTerm2 ────────────

def get_screen_bounds():
    """Get bounds of the screen currently containing the iTerm2 window."""
    script = '''
    tell application "iTerm2"
        set w to current window
        set wb to bounds of w
        set wx to item 1 of wb
        set wy to item 2 of wb
    end tell
    tell application "Finder"
        set allScreens to {bounds of window of desktop}
    end tell
    -- Find which screen contains the iTerm2 window origin
    set result to "0,0,1920,1080"
    tell application "System Events"
        set screenList to {}
        repeat with d in (get every desktop)
            -- not available this way, fall back
        end repeat
    end tell
    return (wx as string) & "," & (wy as string)
    '''

    # Simpler approach: use NSScreen via python to get screen containing mouse,
    # but we don't have AppKit. Instead use system_profiler + iTerm2 window pos.
    # Get iTerm2 window frame, then match against screen list from displayplacer/system_profiler.

    # Get iTerm2 current window bounds via AppleScript
    bounds_script = 'tell application "iTerm2" to get bounds of current window'
    result = subprocess.run(['osascript', '-e', bounds_script], capture_output=True, text=True)

    if result.returncode != 0:
        return 0, 0, 1920, 1080

    parts = [int(p.strip()) for p in result.stdout.strip().split(',')]
    win_x, win_y, win_right, win_bottom = parts
    win_cx = (win_x + win_right) // 2
    win_cy = (win_y + win_bottom) // 2

    # Get all screen frames via NSScreen through a quick python3 call
    screen_script = '''
import subprocess, json
result = subprocess.run(['system_profiler', 'SPDisplaysDataType', '-json'],
    capture_output=True, text=True)
print(result.stdout)
'''
    # Simpler: use Objective-C bridge via osascript to enumerate screens
    screens_script = '''
    tell application "iTerm2"
        set winBounds to bounds of current window
    end tell
    set wx to item 1 of winBounds
    set wy to item 2 of winBounds
    set wr to item 3 of winBounds
    set wb to item 4 of winBounds
    set wCX to (wx + wr) / 2
    set wCY to (wy + wb) / 2

    -- Use Quartz Display Services via do shell script
    -- Return iTerm window bounds for now; caller will use display info
    return (wx as string) & "," & (wy as string) & "," & (wr as string) & "," & (wb as string)
    '''

    # Use Python + Cocoa to get screen frames — available via ctypes on macOS
    cocoa_script = """
import ctypes, ctypes.util

objc = ctypes.cdll.LoadLibrary(ctypes.util.find_library('objc'))
objc.objc_getClass.restype = ctypes.c_void_p
objc.sel_registerName.restype = ctypes.c_void_p
objc.objc_msgSend.restype = ctypes.c_void_p
objc.objc_msgSend.argtypes = [ctypes.c_void_p, ctypes.c_void_p]

def msg(obj, sel, *args):
    return objc.objc_msgSend(obj, objc.sel_registerName(sel.encode()), *args)

NSScreen = objc.objc_getClass(b'NSScreen')
screens = msg(NSScreen, 'screens')
count = msg(screens, 'count')

import ctypes
objc.objc_msgSend.restype = ctypes.c_ulong
count = objc.objc_msgSend(screens, objc.sel_registerName(b'count'))

results = []
for i in range(count):
    objc.objc_msgSend.restype = ctypes.c_void_p
    screen = objc.objc_msgSend(screens, objc.sel_registerName(b'objectAtIndex:'), ctypes.c_ulong(i))

    # Get frame via NSScreen frame — returns NSRect (CGRect)
    class NSPoint(ctypes.Structure):
        _fields_ = [('x', ctypes.c_double), ('y', ctypes.c_double)]
    class NSSize(ctypes.Structure):
        _fields_ = [('width', ctypes.c_double), ('height', ctypes.c_double)]
    class NSRect(ctypes.Structure):
        _fields_ = [('origin', NSPoint), ('size', NSSize)]

    objc.objc_msgSend.restype = NSRect
    frame = objc.objc_msgSend(screen, objc.sel_registerName(b'frame'))
    results.append((frame.origin.x, frame.origin.y, frame.size.width, frame.size.height))

print(','.join(f'{r[0]:.0f}:{r[1]:.0f}:{r[2]:.0f}:{r[3]:.0f}' for r in results))
"""

    result = subprocess.run(['python3', '-c', cocoa_script], capture_output=True, text=True)

    if result.returncode == 0 and result.stdout.strip():
        screens = []
        for part in result.stdout.strip().split(','):
            x, y, w, h = [float(v) for v in part.split(':')]
            screens.append((int(x), int(y), int(w), int(h)))

        # Find screen containing center of iTerm2 window
        for (sx, sy, sw, sh) in screens:
            if sx <= win_cx <= sx + sw and sy <= win_cy <= sy + sh:
                return sx, sy, sw, sh

        # Fallback to first screen
        if screens:
            return screens[0]

    return 0, 0, 1920, 1080

# ── Procedural image generation ───────────────────────────────

def generate_voronoi(seed, width, height, base_hue, base_sat, base_light):
    """Generate background with Voronoi diagram (cellular/territorial patterns)."""
    # Place 12-20 seed points randomly
    num_seeds = 12 + int(srand(seed, 5000) * 9)  # 12-20 points
    seeds = []
    for i in range(num_seeds):
        sx = srand(seed, 6000 + i * 2) * width
        sy = srand(seed, 6000 + i * 2 + 1) * height
        # Each seed gets a hue variation within ±30° of base
        hue = (base_hue + (srand(seed, 7000 + i) * 60 - 30)) % 360
        seeds.append((sx, sy, hue))
    
    pixels = []
    
    for y in range(height):
        for x in range(width):
            # Find two nearest seed points (for soft edge detection)
            distances = []
            for idx, (sx, sy, hue) in enumerate(seeds):
                dx = x - sx
                dy = y - sy
                dist = math.sqrt(dx * dx + dy * dy)
                distances.append((dist, idx))
            
            distances.sort()
            nearest_dist, nearest_idx = distances[0]
            second_dist, second_idx = distances[1]
            
            # Get the color of the nearest cell
            _, _, cell_hue = seeds[nearest_idx]
            
            # Create soft edge effect: if we're near a boundary between cells,
            # the two nearest distances will be close
            edge_threshold = 20.0  # pixels
            dist_diff = second_dist - nearest_dist
            
            # Calculate lightness with subtle edge darkening
            if dist_diff < edge_threshold:
                # Near a boundary - darken slightly for subtle edge
                edge_factor = dist_diff / edge_threshold  # 0.0 (on edge) to 1.0 (far from edge)
                edge_factor = edge_factor * edge_factor  # Smooth curve
                cell_light = base_light + (base_light * 0.5) * edge_factor
            else:
                # Interior of cell - use base lightness + slight variation
                cell_light = base_light + base_light * 0.5
            
            # Clamp lightness to 8-16 range for readability
            cell_light = max(8, min(16, cell_light))
            
            # Add subtle radial gradient within each cell for depth
            radial_factor = min(1.0, nearest_dist / (width * 0.15))
            radial_factor = radial_factor * radial_factor  # Smooth curve
            cell_light = cell_light * (0.85 + 0.15 * radial_factor)
            
            # Keep saturation moderate for subtlety
            cell_sat = base_sat * 0.8
            
            r, g, b = hsl_to_rgb(cell_hue, cell_sat, cell_light)
            pixels.append((r, g, b))
    
    return pixels

def generate_gradient_mesh(seed, width, height, base_hue, base_sat, base_light):
    """Generate background with gradient mesh/metaballs (smooth lava-lamp style)."""
    # Place 8-12 metaball centers randomly
    num_balls = 8 + int(srand(seed, 3000) * 5)  # 8-12 balls
    balls = []
    
    for i in range(num_balls):
        # Random position
        cx = srand(seed, 3100 + i * 2) * width
        cy = srand(seed, 3100 + i * 2 + 1) * height
        
        # Hue variation: ±40° from base
        hue = (base_hue + (srand(seed, 3200 + i) * 80 - 40)) % 360
        
        # Influence radius: varies per ball for more organic feel
        # Scale with screen size
        radius = (0.2 + srand(seed, 3300 + i) * 0.3) * min(width, height)
        
        balls.append((cx, cy, hue, radius))
    
    pixels = []
    
    # For each pixel, calculate combined influence from all metaballs
    for y in range(height):
        for x in range(width):
            # Sum influence from all balls (1/distance^2)
            total_influence = 0.0
            weighted_hue = 0.0
            
            for cx, cy, hue, radius in balls:
                dx = x - cx
                dy = y - cy
                dist = math.sqrt(dx * dx + dy * dy)
                
                # Avoid division by zero at ball center
                dist = max(1.0, dist)
                
                # Inverse square falloff for smooth blending
                # Normalize by radius for size-aware influence
                influence = (radius / dist) ** 2
                
                total_influence += influence
                weighted_hue += hue * influence
            
            # Normalize hue by total influence
            if total_influence > 0:
                final_hue = (weighted_hue / total_influence) % 360
            else:
                final_hue = base_hue
            
            # Map influence to lightness (8-18 range for readability)
            # Higher influence = lighter (closer to metaball centers)
            # Clamp influence to reasonable range for mapping
            clamped_influence = min(total_influence, 5.0)
            normalized_influence = clamped_influence / 5.0  # 0-1 range
            
            # Smooth curve for more organic feel
            normalized_influence = normalized_influence ** 0.7
            
            # Lightness: 8 (dark background) to 18 (brighter near centers)
            final_light = 8 + normalized_influence * 10
            
            # Keep saturation moderate for calming effect
            # Vary slightly with influence for depth
            final_sat = base_sat * (0.7 + 0.3 * normalized_influence)
            
            r, g, b = hsl_to_rgb(final_hue, final_sat, final_light)
            pixels.append((r, g, b))
    
    return pixels

def generate_blobs_waves(seed, width, height, base_hue, base_sat, base_light):
    """Generate background with warped elliptical blobs and sinusoidal waves."""
    bg_r, bg_g, bg_b = hsl_to_rgb(base_hue, base_sat, base_light)
    pixels = [(bg_r, bg_g, bg_b)] * (width * height)

    num_blobs = 6
    blobs = []
    for i in range(num_blobs):
        cx = srand(seed, 100 + i) * width
        cy = srand(seed, 200 + i) * height
        rx = (0.15 + srand(seed, 300 + i) * 0.2) * width
        ry = (0.15 + srand(seed, 400 + i) * 0.2) * height
        hue = (base_hue + srand(seed, 500 + i) * 50 - 25) % 360   # ±25° around identity
        sat = 55 + srand(seed, 600 + i) * 25                      # 55-80, bold
        lit = 28 + srand(seed, 700 + i) * 20                      # 28-48, vivid pools
        alpha = 0.18 + srand(seed, 800 + i) * 0.20                # 0.18-0.38
        warp_freq = 2 + srand(seed, 900 + i) * 4
        warp_amp  = 0.1 + srand(seed, 1000 + i) * 0.2
        blobs.append((cx, cy, rx, ry, hue, sat, lit, alpha, warp_freq, warp_amp))

    num_waves = 5
    waves = []
    for i in range(num_waves):
        y_base = srand(seed, 1100 + i) * height
        amp    = (0.04 + srand(seed, 1200 + i) * 0.08) * height
        freq   = 1 + srand(seed, 1300 + i) * 3
        phase  = srand(seed, 1400 + i) * 2 * math.pi
        hue    = (base_hue + srand(seed, 1500 + i) * 40 - 20) % 360   # ±20° around identity
        alpha  = 0.10 + srand(seed, 1600 + i) * 0.12
        thickness = max(1, int(1 + srand(seed, 1700 + i) * 2))
        waves.append((y_base, amp, freq, phase, hue, alpha, thickness))

    blob_colors = [hsl_to_rgb(h, s, l) for (_, _, _, _, h, s, l, _, _, _) in blobs]
    wave_colors = [hsl_to_rgb(h, 50, 60) for (_, _, _, _, h, _, _) in waves]

    for y in range(height):
        for x in range(width):
            r, g, b = pixels[y * width + x]

            for idx, (cx, cy, rx, ry, hue, sat, lit, alpha, warp_freq, warp_amp) in enumerate(blobs):
                angle = math.atan2(y - cy, x - cx)
                warp = 1 + warp_amp * math.sin(warp_freq * angle)
                dx = (x - cx) / (rx * warp)
                dy = (y - cy) / (ry * warp)
                dist_sq = dx*dx + dy*dy
                if dist_sq < 1.0:
                    t = 1 - math.sqrt(dist_sq)
                    t = t * t * (3 - 2 * t)
                    fr, fg, fb = blob_colors[idx]
                    ea = alpha * t
                    r = int(fr * ea + r * (1 - ea))
                    g = int(fg * ea + g * (1 - ea))
                    b = int(fb * ea + b * (1 - ea))

            for idx, (y_base, amp, freq, phase, hue, alpha, thickness) in enumerate(waves):
                wave_y = y_base + amp * math.sin(freq * 2 * math.pi * x / width + phase)
                dist = abs(y - wave_y)
                if dist < thickness + 1:
                    t = max(0.0, 1 - dist / (thickness + 1))
                    wr, wg, wb = wave_colors[idx]
                    ea = alpha * t
                    r = int(wr * ea + r * (1 - ea))
                    g = int(wg * ea + g * (1 - ea))
                    b = int(wb * ea + b * (1 - ea))

            pixels[y * width + x] = (
                max(0, min(255, r)),
                max(0, min(255, g)),
                max(0, min(255, b))
            )

    return pixels

def generate_flow_field(seed, width, height, base_hue, base_sat, base_light):
    """Generate background with flow field (curved, flowing lines)."""
    # Algorithm:
    # 1. Create vector field (grid of angles/directions)
    # 2. Place 20-30 particle start points
    # 3. Trace each particle path following vector field
    # 4. Draw semi-transparent lines along paths
    # 5. Use base_hue with slight variations
    # 6. Keep dark (lightness 8-14) with glowing lines (lightness 25-40)
    
    # Initialize with dark background
    bg_r, bg_g, bg_b = hsl_to_rgb(base_hue, base_sat, base_light)
    pixels = [(bg_r, bg_g, bg_b)] * (width * height)
    
    # Create a grid for the vector field
    grid_size = 20  # Resolution of flow field grid
    cols = width // grid_size + 2
    rows = height // grid_size + 2
    
    # Generate vector field using noise-like patterns
    vector_field = []
    for r in range(rows):
        row_vectors = []
        for c in range(cols):
            # Use deterministic "noise" from srand
            angle = srand(seed, r * 1000 + c) * math.pi * 4  # 0 to 4π for variety
            # Add some coherent flow with Perlin-like smoothness
            x_influence = math.sin(c * 0.3 + srand(seed, 5000) * 10)
            y_influence = math.cos(r * 0.3 + srand(seed, 5001) * 10)
            angle += (x_influence + y_influence) * 0.5
            row_vectors.append(angle)
        vector_field.append(row_vectors)
    
    # Create 20-30 particle trails
    num_particles = int(20 + srand(seed, 9000) * 10)
    
    for p_idx in range(num_particles):
        # Random start position
        x = srand(seed, 10000 + p_idx) * width
        y = srand(seed, 20000 + p_idx) * height
        
        # Path parameters
        max_steps = int(100 + srand(seed, 30000 + p_idx) * 150)
        step_length = 1.5 + srand(seed, 40000 + p_idx) * 1.5
        
        # Color variation for this particle
        hue_offset = (srand(seed, 50000 + p_idx) - 0.5) * 30  # ±15 degrees
        particle_hue = (base_hue + hue_offset) % 360
        particle_light = 25 + srand(seed, 60000 + p_idx) * 15  # 25-40 for glowing
        particle_sat = 60 + srand(seed, 70000 + p_idx) * 30  # 60-90 for vivid
        
        # Trail thickness and opacity
        base_thickness = 1.5 + srand(seed, 80000 + p_idx) * 2.5  # 1.5-4.0
        base_alpha = 0.15 + srand(seed, 90000 + p_idx) * 0.25  # 0.15-0.40
        
        # Trace the particle path
        path = [(x, y)]
        for step in range(max_steps):
            # Get vector from field
            grid_x = int(x / grid_size)
            grid_y = int(y / grid_size)
            
            if 0 <= grid_y < rows and 0 <= grid_x < cols:
                angle = vector_field[grid_y][grid_x]
                
                # Move particle
                dx = math.cos(angle) * step_length
                dy = math.sin(angle) * step_length
                x += dx
                y += dy
                
                # Stop if out of bounds
                if x < 0 or x >= width or y < 0 or y >= height:
                    break
                
                path.append((x, y))
            else:
                break
        
        # Draw the path with gradient falloff
        if len(path) > 1:
            line_color = hsl_to_rgb(particle_hue, particle_sat, particle_light)
            
            for i in range(len(path) - 1):
                x0, y0 = path[i]
                x1, y1 = path[i + 1]
                
                # Fade alpha along the trail (fade out at end)
                trail_progress = i / len(path)
                fade_factor = 1.0 - (trail_progress ** 2)  # Quadratic falloff
                alpha = base_alpha * fade_factor
                
                # Draw thick line with anti-aliasing
                _draw_thick_line(pixels, width, height,
                              int(x0), int(y0), int(x1), int(y1),
                              line_color, alpha, base_thickness)
    
    return pixels

def _draw_thick_line(pixels, width, height, x0, y0, x1, y1, color, alpha, thickness):
    """Draw a line with thickness and gradient falloff (Bresenham-based)."""
    cr, cg, cb = color
    
    # Bresenham's line algorithm with thickness
    dx = abs(x1 - x0)
    dy = abs(y1 - y0)
    sx = 1 if x0 < x1 else -1
    sy = 1 if y0 < y1 else -1
    err = dx - dy
    
    # Draw points along the line
    x, y = x0, y0
    
    while True:
        # Draw thick point with gradient falloff
        for offset_x in range(-int(thickness) - 1, int(thickness) + 2):
            for offset_y in range(-int(thickness) - 1, int(thickness) + 2):
                px = x + offset_x
                py = y + offset_y
                
                if 0 <= px < width and 0 <= py < height:
                    # Calculate distance from line center for gradient
                    dist = math.sqrt(offset_x**2 + offset_y**2)
                    
                    # Gradient falloff (brighter at center, fades to edges)
                    if dist <= thickness + 1:
                        falloff = max(0, 1 - (dist / (thickness + 1)))
                        falloff = falloff ** 1.5  # Steeper falloff for glow effect
                        
                        effective_alpha = alpha * falloff
                        
                        if effective_alpha > 0.01:  # Skip very transparent pixels
                            idx = py * width + px
                            r, g, b = pixels[idx]
                            
                            # Alpha blend
                            r = int(cr * effective_alpha + r * (1 - effective_alpha))
                            g = int(cg * effective_alpha + g * (1 - effective_alpha))
                            b = int(cb * effective_alpha + b * (1 - effective_alpha))
                            
                            pixels[idx] = (
                                max(0, min(255, r)),
                                max(0, min(255, g)),
                                max(0, min(255, b))
                            )
        
        if x == x1 and y == y1:
            break
        
        e2 = 2 * err
        if e2 > -dy:
            err -= dy
            x += sx
        if e2 < dx:
            err += dx
            y += sy

def generate_circuits(seed, width, height, base_hue, base_sat, base_light):
    """Generate background with circuit board traces (tech-inspired)."""
    # Initialize with dark base (lightness 8-12)
    bg_light = 8 + srand(seed, 3000) * 4  # 8-12
    bg_r, bg_g, bg_b = hsl_to_rgb(base_hue, base_sat * 0.6, bg_light)
    pixels = [(bg_r, bg_g, bg_b)] * (width * height)
    
    # Generate 8-12 horizontal/vertical trace paths
    num_traces = 8 + int(srand(seed, 3100) * 5)  # 8-12 traces
    
    traces = []
    for i in range(num_traces):
        # Random start position
        is_horizontal = srand(seed, 3200 + i) > 0.5
        
        if is_horizontal:
            # Horizontal trace
            y = int(srand(seed, 3300 + i) * height)
            x_start = int(srand(seed, 3400 + i) * width * 0.3)  # Start in left 30%
            x_end = int(width * 0.7 + srand(seed, 3500 + i) * width * 0.3)  # End in right 70-100%
            
            # Add some segments (not just straight line)
            segments = []
            x_current = x_start
            y_current = y
            
            # Create 2-4 Manhattan routing segments
            num_segments = 2 + int(srand(seed, 3600 + i) * 3)
            for seg in range(num_segments):
                # Alternate between horizontal and vertical
                if seg % 2 == 0:  # Horizontal
                    x_target = x_current + int((x_end - x_current) / (num_segments - seg) * 
                                              (0.7 + srand(seed, 3700 + i * 10 + seg) * 0.6))
                    segments.append(((x_current, y_current), (x_target, y_current)))
                    x_current = x_target
                else:  # Vertical jog
                    y_offset = int((srand(seed, 3800 + i * 10 + seg) - 0.5) * height * 0.1)
                    y_target = max(0, min(height - 1, y_current + y_offset))
                    segments.append(((x_current, y_current), (x_current, y_target)))
                    y_current = y_target
            
            # Final segment to end point
            segments.append(((x_current, y_current), (x_end, y_current)))
            traces.append(segments)
            
        else:
            # Vertical trace
            x = int(srand(seed, 3300 + i) * width)
            y_start = int(srand(seed, 3400 + i) * height * 0.3)
            y_end = int(height * 0.7 + srand(seed, 3500 + i) * height * 0.3)
            
            segments = []
            x_current = x
            y_current = y_start
            
            num_segments = 2 + int(srand(seed, 3600 + i) * 3)
            for seg in range(num_segments):
                if seg % 2 == 0:  # Vertical
                    y_target = y_current + int((y_end - y_current) / (num_segments - seg) * 
                                              (0.7 + srand(seed, 3700 + i * 10 + seg) * 0.6))
                    segments.append(((x_current, y_current), (x_current, y_target)))
                    y_current = y_target
                else:  # Horizontal jog
                    x_offset = int((srand(seed, 3800 + i * 10 + seg) - 0.5) * width * 0.1)
                    x_target = max(0, min(width - 1, x_current + x_offset))
                    segments.append(((x_current, y_current), (x_target, y_current)))
                    x_current = x_target
            
            segments.append(((x_current, y_current), (x_current, y_end)))
            traces.append(segments)
    
    # Trace color: brighter than background (lightness 18-28)
    trace_light = 18 + srand(seed, 3900) * 10  # 18-28
    trace_sat = base_sat * 0.8
    trace_r, trace_g, trace_b = hsl_to_rgb(base_hue, trace_sat, trace_light)
    
    # Glow color: even brighter for subtle glow
    glow_light = trace_light + 8  # About 26-36
    glow_r, glow_g, glow_b = hsl_to_rgb(base_hue, trace_sat * 0.6, glow_light)
    
    # Helper: draw line with glow
    def draw_trace_line(x0, y0, x1, y1):
        """Draw circuit trace line with subtle glow."""
        # Bresenham's line algorithm
        dx = abs(x1 - x0)
        dy = abs(y1 - y0)
        sx = 1 if x0 < x1 else -1
        sy = 1 if y0 < y1 else -1
        err = dx - dy
        
        x, y = x0, y0
        
        while True:
            # Draw glow (2px radius)
            for glow_offset in range(-2, 3):
                for glow_offset_y in range(-2, 3):
                    gx = x + glow_offset
                    gy = y + glow_offset_y
                    
                    if 0 <= gx < width and 0 <= gy < height:
                        dist = math.sqrt(glow_offset**2 + glow_offset_y**2)
                        
                        if dist < 2.5:
                            idx = gy * width + gx
                            r, g, b = pixels[idx]
                            
                            # Glow falloff
                            if dist < 1.0:
                                # Core trace - full brightness
                                alpha = 0.9
                                blend_r, blend_g, blend_b = trace_r, trace_g, trace_b
                            else:
                                # Glow - fades with distance
                                falloff = 1.0 - ((dist - 1.0) / 1.5)
                                falloff = max(0, falloff)
                                alpha = 0.3 * falloff
                                blend_r, blend_g, blend_b = glow_r, glow_g, glow_b
                            
                            r = int(blend_r * alpha + r * (1 - alpha))
                            g = int(blend_g * alpha + g * (1 - alpha))
                            b = int(blend_b * alpha + b * (1 - alpha))
                            
                            pixels[idx] = (
                                max(0, min(255, r)),
                                max(0, min(255, g)),
                                max(0, min(255, b))
                            )
            
            if x == x1 and y == y1:
                break
            
            e2 = 2 * err
            if e2 > -dy:
                err -= dy
                x += sx
            if e2 < dx:
                err += dx
                y += sy
    
    # Helper: draw junction node (small circle)
    def draw_node(cx, cy, radius=3):
        """Draw junction node with glow."""
        for dy in range(-radius - 2, radius + 3):
            for dx in range(-radius - 2, radius + 3):
                px = cx + dx
                py = cy + dy
                
                if 0 <= px < width and 0 <= py < height:
                    dist = math.sqrt(dx**2 + dy**2)
                    
                    if dist < radius + 2:
                        idx = py * width + px
                        r, g, b = pixels[idx]
                        
                        if dist < radius:
                            # Core node
                            alpha = 0.95
                            blend_r, blend_g, blend_b = trace_r, trace_g, trace_b
                        else:
                            # Glow
                            falloff = 1.0 - ((dist - radius) / 2.0)
                            alpha = 0.4 * max(0, falloff)
                            blend_r, blend_g, blend_b = glow_r, glow_g, glow_b
                        
                        r = int(blend_r * alpha + r * (1 - alpha))
                        g = int(blend_g * alpha + g * (1 - alpha))
                        b = int(blend_b * alpha + b * (1 - alpha))
                        
                        pixels[idx] = (
                            max(0, min(255, r)),
                            max(0, min(255, g)),
                            max(0, min(255, b))
                        )
    
    # Helper: draw endpoint pad (slightly larger circle)
    def draw_pad(cx, cy, radius=4):
        """Draw endpoint pad."""
        draw_node(cx, cy, radius)
    
    # Draw all traces
    for trace_segments in traces:
        for segment in trace_segments:
            (x0, y0), (x1, y1) = segment
            draw_trace_line(x0, y0, x1, y1)
        
        # Draw junction nodes at segment connections
        for i in range(len(trace_segments) - 1):
            _, (x, y) = trace_segments[i]
            draw_node(x, y, 2)
        
        # Draw endpoint pads
        (x_start, y_start), _ = trace_segments[0]
        _, (x_end, y_end) = trace_segments[-1]
        draw_pad(x_start, y_start, 3)
        draw_pad(x_end, y_end, 3)
    
    return pixels

# ── Generator selector ────────────────────────────────────────

def select_generator(project_name):
    """Deterministically select one of the 10 generators based on project name."""
    generators = [
        generate_blobs_waves,
        generate_perlin_noise,
        generate_voronoi,
        generate_flow_field,
        generate_topographic,
        generate_constellation,
        generate_tessellation,
        generate_gradient_mesh,
        generate_circuits,
        generate_fourier_harmonics,
    ]
    
    idx = int(srand(project_name, 8888) * len(generators)) % len(generators)
    return generators[idx]

def generate_background_image(project_name, width=960, height=540):
    seed = project_name

    # Pick this project's bold identity color
    base_hue, base_sat, base_light = select_scheme(seed)
    
    # Select generator deterministically based on project name
    generator = select_generator(project_name)
    
    # Generate pixels using selected approach
    pixels = generator(seed, width, height, base_hue, base_sat, base_light)

    tmp_dir = tempfile.mkdtemp(prefix="new-project-")
    png_path = os.path.join(tmp_dir, f"{project_name}.png")
    write_png(pixels, width, height, png_path)
    return png_path

# ── Profile helpers ───────────────────────────────────────────

async def set_pane_profile(session, r, g, b, bg_image_path=None):
    profile = iterm2.LocalWriteOnlyProfile()
    profile.set_background_color(iterm2.Color(r, g, b))
    if bg_image_path:
        profile.set_background_image_location(bg_image_path)
        profile.set_blend(0.88)
    await session.async_set_profile_properties(profile)

# ── Spinner ──────────────────────────────────────────────────────

class Spinner:
    """Animated spinner for terminal feedback during long operations."""
    def __init__(self, message="Processing"):
        self.message = message
        self.frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
        self.running = False
        self.thread = None

    def _spin(self):
        idx = 0
        while self.running:
            frame = self.frames[idx % len(self.frames)]
            sys.stdout.write(f'\r{frame} {self.message}...')
            sys.stdout.flush()
            idx += 1
            time.sleep(0.08)
        sys.stdout.write('\r' + ' ' * (len(self.message) + 10) + '\r')
        sys.stdout.flush()

    def start(self):
        self.running = True
        self.thread = threading.Thread(target=self._spin, daemon=True)
        self.thread.start()
        return self

    def stop(self):
        self.running = False
        if self.thread:
            self.thread.join()

    def __enter__(self):
        self.start()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.stop()

# ── Main ──────────────────────────────────────────────────────

async def main(connection):
    args = sys.argv[1:]
    if len(args) < 2:
        usage()

    project_name = args[0]
    base_dir = os.path.expanduser(args[1])

    if not os.path.isdir(base_dir):
        print(f"Error: directory '{base_dir}' does not exist")
        sys.exit(1)

    with Spinner(f"Generating background for '{project_name}'"):
        bg_image = generate_background_image(project_name)
    print(f"✓ Background generated")

    app = await iterm2.async_get_app(connection)

    window = await iterm2.Window.async_create(connection)
    if window is None:
        print("Error: could not create iTerm2 window")
        sys.exit(1)

    await window.async_set_title(project_name)

    # ── Resize to 75% of current screen, centered ─────────────
    screen_x, screen_y, screen_w, screen_h = get_screen_bounds()
    new_w = int(screen_w * 0.75)
    new_h = int(screen_h * 0.75)
    new_x = screen_x + int((screen_w - new_w) / 2)
    new_y = screen_y + int((screen_h - new_h) / 2)

    await window.async_set_frame(iterm2.Frame(
        iterm2.Point(new_x, new_y),
        iterm2.Size(new_w, new_h)
    ))

    tab = window.current_tab
    await tab.async_set_title(project_name)

    # ── Build layout ──────────────────────────────────────────
    pi_dev = tab.current_session
    nvim = await pi_dev.async_split_pane(vertical=True)
    pi_review = await pi_dev.async_split_pane(vertical=False)
    scratch1 = await nvim.async_split_pane(vertical=False)
    scratch2 = await scratch1.async_split_pane(vertical=False)
    scratch3 = await scratch2.async_split_pane(vertical=False)

    # ── Adjust pane sizes ─────────────────────────────────────
    total_rows = pi_dev.grid_size.height + pi_review.grid_size.height
    half  = math.floor(total_rows / 2)
    third = math.floor(total_rows / 6)

    pi_dev.preferred_size    = iterm2.Size(pi_dev.grid_size.width, half)
    pi_review.preferred_size = iterm2.Size(pi_review.grid_size.width, total_rows - half)
    nvim.preferred_size          = iterm2.Size(nvim.grid_size.width, half)
    scratch1.preferred_size      = iterm2.Size(scratch1.grid_size.width, third)
    scratch2.preferred_size      = iterm2.Size(scratch2.grid_size.width, third)
    scratch3.preferred_size      = iterm2.Size(scratch3.grid_size.width, third)

    await tab.async_update_layout()

    # ── Set colors + background ───────────────────────────────
    await set_pane_profile(pi_dev,    0,  0,  0,  bg_image)
    await set_pane_profile(pi_review, 0,  0,  80, bg_image)
    await set_pane_profile(nvim,          0,  0,  0,  bg_image)
    await set_pane_profile(scratch1,      0,  40, 0,  bg_image)
    await set_pane_profile(scratch2,      0,  40, 0,  bg_image)
    await set_pane_profile(scratch3,      0,  40, 0,  bg_image)

    # ── Name each pane ────────────────────────────────────────
    pane_names = {
        pi_dev:    f"{project_name}:pi-dev",
        pi_review: f"{project_name}:pi-review",
        nvim:          f"{project_name}:nvim",
        scratch1:      f"{project_name}:scratch-1",
        scratch2:      f"{project_name}:scratch-2",
        scratch3:      f"{project_name}:scratch-3",
    }
    for session, name in pane_names.items():
        await session.async_set_name(name)

    # ── Send commands ─────────────────────────────────────────
    cd = f"cd {base_dir}\n"

    await pi_dev.async_send_text(cd)
    await pi_dev.async_send_text("pi\n")

    await pi_review.async_send_text(cd)
    await pi_review.async_send_text("pi\n")

    await nvim.async_send_text(cd)
    await nvim.async_send_text("nvim .\n")

    for scratch in [scratch1, scratch2, scratch3]:
        await scratch.async_send_text(cd)

    await pi_dev.async_activate()

iterm2.run_until_complete(main)
