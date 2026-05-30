import os
from PIL import Image

images_dir = "/Users/marcosfagner/Downloads/META AI FRAMES/ECOMERCE-MERCADO LIVRE-main/images"
nessa_dir = os.path.join(images_dir, "nessa")
transparent_path = os.path.join(nessa_dir, "studio_front_transparent.png")

# Open transparent Nessa
nessa = Image.open(transparent_path)

banners = ["banner_casa.png", "banner_tech.png", "banner_beleza.png"]

for banner_name in banners:
    banner_path = os.path.join(images_dir, banner_name)
    if not os.path.exists(banner_path):
        print(f"Banner not found: {banner_path}")
        continue
        
    banner = Image.open(banner_path).convert("RGBA")
    b_width, b_height = banner.size
    print(f"Processing banner: {banner_name} ({b_width}x{b_height})")
    
    # Scale Nessa proportionally to fit the banner height
    # Let's make her height about 85% of the banner height
    target_height = int(b_height * 0.85)
    scale_factor = target_height / nessa.height
    target_width = int(nessa.width * scale_factor)
    
    nessa_resized = nessa.resize((target_width, target_height), Image.Resampling.LANCZOS)
    
    # Calculate position: Place her on the right side of the banner
    # Let's align her bottom with the bottom of the banner (y = b_height - target_height)
    # And place her offset from the right edge
    x_pos = b_width - target_width - int(b_width * 0.05) # 5% padding from the right edge
    y_pos = b_height - target_height
    
    # Paste Nessa onto the banner using her alpha channel as a mask
    banner.paste(nessa_resized, (x_pos, y_pos), nessa_resized)
    
    # Save the composited banner back as a high-quality PNG
    banner.convert("RGB").save(banner_path, "PNG")
    print(f"Composited banner saved successfully: {banner_name}")

print("All banners updated with Nessa!")
