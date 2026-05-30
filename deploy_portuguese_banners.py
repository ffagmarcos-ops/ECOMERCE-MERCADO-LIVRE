import os
import shutil

# Correct generated absolute paths from metadata
cafe_pt_source = "/Users/marcosfagner/.gemini/antigravity/brain/423183c1-7a69-4c3e-9088-1ff44ccb77b7/nessa_cafe_banner_pt_1780066196158.png"
aspirador_pt_source = "/Users/marcosfagner/.gemini/antigravity/brain/423183c1-7a69-4c3e-9088-1ff44ccb77b7/nessa_aspirador_banner_pt_1780066252563.png"
ventilador_pt_source = "/Users/marcosfagner/.gemini/antigravity/brain/423183c1-7a69-4c3e-9088-1ff44ccb77b7/nessa_ventilador_banner_pt_1780066335497.png"

images_dir = "/Users/marcosfagner/Downloads/META AI FRAMES/ECOMERCE-MERCADO LIVRE-main/images"

# 1. Main slider banner destinations (replacing previous backgrounds)
shutil.copy2(cafe_pt_source, os.path.join(images_dir, "banner_casa.png"))
shutil.copy2(aspirador_pt_source, os.path.join(images_dir, "banner_tech.png"))
shutil.copy2(ventilador_pt_source, os.path.join(images_dir, "banner_beleza.png"))

# 2. Mini banner destinations
shutil.copy2(cafe_pt_source, os.path.join(images_dir, "nessa_cafe_banner.png"))
shutil.copy2(aspirador_pt_source, os.path.join(images_dir, "nessa_aspirador_banner.png"))
shutil.copy2(ventilador_pt_source, os.path.join(images_dir, "nessa_ventilador_banner.png"))

print("All Portuguese ad banners deployed successfully to main backgrounds and mini banners!")
