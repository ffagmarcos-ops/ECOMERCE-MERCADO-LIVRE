import os
from PIL import Image

image_path = "/Users/marcosfagner/.gemini/antigravity/brain/423183c1-7a69-4c3e-9088-1ff44ccb77b7/media__1780065047160.jpg"
img = Image.open(image_path)
width, height = img.size

print(f"Image opened successfully: {width}x{height}")

# Convert to grayscale to find lines
gray = img.convert("L")
pixels = list(gray.getdata())

# Convert to 2D list
rows = [pixels[i*width:(i+1)*width] for i in range(height)]
cols = [[rows[r][c] for r in range(height)] for c in range(width)]

row_avgs = [sum(r)/len(r) for r in rows]
col_avgs = [sum(c)/len(c) for c in cols]

nessa_dir = "/Users/marcosfagner/Downloads/META AI FRAMES/ECOMERCE-MERCADO LIVRE-main/images/nessa"
os.makedirs(nessa_dir, exist_ok=True)

# Crop the 3 bottom studio panels:
# Using actual physical spaces in the path
img.crop((0, 380, 341, 682)).save(os.path.join(nessa_dir, "studio_front.png"))
img.crop((341, 380, 682, 682)).save(os.path.join(nessa_dir, "studio_side.png"))
img.crop((682, 380, 1024, 682)).save(os.path.join(nessa_dir, "studio_back.png"))

# Let's crop the 10 faces from the top right grid:
# Face grid starts at x=480, y=0. Width=544, Height=380.
# 5 columns: width of each col = 544/5 = 108.8.
# 2 rows: height of each row = 380/2 = 190.
for row_idx in range(2):
    for col_idx in range(5):
        x1 = int(480 + col_idx * 108.8)
        y1 = int(row_idx * 190)
        x2 = int(480 + (col_idx + 1) * 108.8)
        y2 = int((row_idx + 1) * 190)
        face = img.crop((x1, y1, x2, y2))
        face_idx = row_idx * 5 + col_idx + 1
        face.save(os.path.join(nessa_dir, f"face_{face_idx}.png"))

# Let's crop the top-left apartment full-body panels:
# Width = 480, Height = 380. 3 columns of 160 width.
for col_idx in range(3):
    x1 = col_idx * 160
    y1 = 0
    x2 = (col_idx + 1) * 160
    y2 = 380
    apt = img.crop((x1, y1, x2, y2))
    apt_idx = col_idx + 1
    apt.save(os.path.join(nessa_dir, f"apt_{apt_idx}.png"))

print("All segments cropped and saved successfully!")
