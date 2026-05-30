import os
from PIL import Image

# Exact absolute paths of the generated images from brain metadata
cafe_gen_path = "/Users/marcosfagner/.gemini/antigravity/brain/423183c1-7a69-4c3e-9088-1ff44ccb77b7/nessa_cafe_banner_1780065830905.png"
aspirador_gen_path = "/Users/marcosfagner/.gemini/antigravity/brain/423183c1-7a69-4c3e-9088-1ff44ccb77b7/nessa_aspirador_banner_1780065856465.png"
ventilador_gen_path = "/Users/marcosfagner/.gemini/antigravity/brain/423183c1-7a69-4c3e-9088-1ff44ccb77b7/nessa_ventilador_banner_1780065895589.png"

dest_dir = "/Users/marcosfagner/Downloads/META AI FRAMES/ECOMERCE-MERCADO LIVRE-main/images"
os.makedirs(dest_dir, exist_ok=True)

# 1. Process Coffee Banner (Crop bottom text)
if os.path.exists(cafe_gen_path):
    img = Image.open(cafe_gen_path)
    width, height = img.size
    # Crop the bottom 115 pixels where the placeholder name is
    cropped_img = img.crop((0, 0, width, height - 115))
    cropped_img.save(os.path.join(dest_dir, "nessa_cafe_banner.png"), "PNG")
    print("Coffee banner processed and cropped successfully!")
else:
    print("Coffee banner source not found!")

# 2. Process Vacuum Banner
if os.path.exists(aspirador_gen_path):
    img = Image.open(aspirador_gen_path)
    img.save(os.path.join(dest_dir, "nessa_aspirador_banner.png"), "PNG")
    print("Vacuum banner saved successfully!")
else:
    print("Vacuum banner source not found!")

# 3. Process Fan Banner
if os.path.exists(ventilador_gen_path):
    img = Image.open(ventilador_gen_path)
    img.save(os.path.join(dest_dir, "nessa_ventilador_banner.png"), "PNG")
    print("Fan banner saved successfully!")
else:
    print("Fan banner source not found!")

print("All new ad banners processed successfully!")
