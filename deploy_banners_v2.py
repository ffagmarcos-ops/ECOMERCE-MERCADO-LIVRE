import os
import shutil

# Exact absolute paths of newly generated high-quality images from brain
cafe_wide_src = "/Users/marcosfagner/.gemini/antigravity/brain/423183c1-7a69-4c3e-9088-1ff44ccb77b7/nessa_cafe_banner_wide_1780067026198.png"
aspirador_wide_src = "/Users/marcosfagner/.gemini/antigravity/brain/423183c1-7a69-4c3e-9088-1ff44ccb77b7/nessa_aspirador_banner_wide_1780067110426.png"
ventilador_wide_src = "/Users/marcosfagner/.gemini/antigravity/brain/423183c1-7a69-4c3e-9088-1ff44ccb77b7/nessa_ventilador_banner_wide_1780067127163.png"

cafe_mini_src = "/Users/marcosfagner/.gemini/antigravity/brain/423183c1-7a69-4c3e-9088-1ff44ccb77b7/nessa_cafe_mini_1780067147136.png"
aspirador_mini_src = "/Users/marcosfagner/.gemini/antigravity/brain/423183c1-7a69-4c3e-9088-1ff44ccb77b7/nessa_aspirador_mini_1780067170507.png"
ventilador_mini_src = "/Users/marcosfagner/.gemini/antigravity/brain/423183c1-7a69-4c3e-9088-1ff44ccb77b7/nessa_ventilador_mini_1780067197914.png"

images_dir = "/Users/marcosfagner/Downloads/META AI FRAMES/ECOMERCE-MERCADO LIVRE-main/images"

# Make sure images directory exists
os.makedirs(images_dir, exist_ok=True)

# 1. Copy Widescreen Banners for Main Carousel Slides
if os.path.exists(cafe_wide_src):
    shutil.copy2(cafe_wide_src, os.path.join(images_dir, "banner_casa.png"))
    print("Main Coffee Widescreen Banner copied successfully as banner_casa.png")
else:
    print(f"Error: Wide Coffee source not found: {cafe_wide_src}")

if os.path.exists(aspirador_wide_src):
    shutil.copy2(aspirador_wide_src, os.path.join(images_dir, "banner_tech.png"))
    print("Main Vacuum Widescreen Banner copied successfully as banner_tech.png")
else:
    print(f"Error: Wide Vacuum source not found: {aspirador_wide_src}")

if os.path.exists(ventilador_wide_src):
    shutil.copy2(ventilador_wide_src, os.path.join(images_dir, "banner_beleza.png"))
    print("Main Fan Widescreen Banner copied successfully as banner_beleza.png")
else:
    print(f"Error: Wide Fan source not found: {ventilador_wide_src}")

# 2. Copy Square Mini Banners for Spotlights Section
if os.path.exists(cafe_mini_src):
    shutil.copy2(cafe_mini_src, os.path.join(images_dir, "nessa_cafe_banner.png"))
    print("Mini Coffee Square Banner copied successfully as nessa_cafe_banner.png")
else:
    print(f"Error: Mini Coffee source not found: {cafe_mini_src}")

if os.path.exists(aspirador_mini_src):
    shutil.copy2(aspirador_mini_src, os.path.join(images_dir, "nessa_aspirador_banner.png"))
    print("Mini Vacuum Square Banner copied successfully as nessa_aspirador_banner.png")
else:
    print(f"Error: Mini Vacuum source not found: {aspirador_mini_src}")

if os.path.exists(ventilador_mini_src):
    shutil.copy2(ventilador_mini_src, os.path.join(images_dir, "nessa_ventilador_banner.png"))
    print("Mini Fan Square Banner copied successfully as nessa_ventilador_banner.png")
else:
    print(f"Error: Mini Fan source not found: {ventilador_mini_src}")

print("All exclusive images deployed successfully!")
