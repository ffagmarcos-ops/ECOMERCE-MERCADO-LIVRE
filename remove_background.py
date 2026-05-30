import os
from PIL import Image

nessa_dir = "/Users/marcosfagner/Downloads/META AI FRAMES/ECOMERCE-MERCADO LIVRE-main/images/nessa"
studio_front_path = os.path.join(nessa_dir, "studio_front.png")

# Open Nessa studio pose
img = Image.open(studio_front_path).convert("RGBA")
width, height = img.size

# Let's perform a flood-fill from the corners to create a transparency mask
# We want to change the white background pixels to transparent (0, 0, 0, 0)
# A simple queue-based flood fill starting from the corners
# Background color in the corners is very close to white (typically > 240 in R, G, B)
data = img.getdata()
new_data = list(data)

# Let's define a flood fill function
# We'll treat any pixel that is very bright (R > 230, G > 230, B > 230) as background
# if it is connected to the corners.
visited = set()
queue = []

# Add the 4 corners and the borders to the queue as starting points
for x in range(width):
    queue.append((x, 0))
    queue.append((x, height - 1))
for y in range(height):
    queue.append((0, y))
    queue.append((width - 1, y))

while queue:
    curr = queue.pop(0)
    if curr in visited:
        continue
    visited.add(curr)
    
    x, y = curr
    pixel = img.getpixel((x, y))
    r, g, b, a = pixel
    
    # Check if the pixel is white/bright background (R, G, B > 230)
    # Since the studio background is clean, this is highly reliable
    if r > 225 and g > 225 and b > 225:
        # Make transparent
        new_data[y * width + x] = (0, 0, 0, 0)
        
        # Add neighbors
        for dx, dy in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
            nx, ny = x + dx, y + dy
            if 0 <= nx < width and 0 <= ny < height:
                if (nx, ny) not in visited:
                    queue.append((nx, ny))

img.putdata(new_data)

# Save the transparent influencer image
transparent_path = os.path.join(nessa_dir, "studio_front_transparent.png")
img.save(transparent_path, "PNG")
print("Transparent Nessa image created successfully!")
