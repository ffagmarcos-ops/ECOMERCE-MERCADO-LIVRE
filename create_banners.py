import os
from PIL import Image, ImageDraw, ImageFont, ImageChops

# Setup paths
images_dir = "/Users/marcosfagner/Downloads/META AI FRAMES/ECOMERCE-MERCADO LIVRE-main/images"
nessa_dir = os.path.join(images_dir, "nessa")
brain_dir = "/Users/marcosfagner/.gemini/antigravity/brain/423183c1-7a69-4c3e-9088-1ff44ccb77b7"

# Banner dimensions
W, H = 1920, 600

# Fonts
font_bold_path = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
font_reg_path = "/System/Library/Fonts/Supplemental/Arial.ttf"

title_font = ImageFont.truetype(font_bold_path, 58)
subtitle_font = ImageFont.truetype(font_reg_path, 22)
badge_font = ImageFont.truetype(font_bold_path, 12)

def create_base_canvas(color_left, color_right):
    """Creates a 1920x600 canvas with a content-matching horizontal gradient."""
    canvas = Image.new("RGBA", (W, H), (255, 255, 255, 255))
    draw = ImageDraw.Draw(canvas)
    
    # Draw horizontal gradient
    for x in range(W):
        t = x / W
        r = int(color_left[0] * (1 - t) + color_right[0] * t)
        g = int(color_left[1] * (1 - t) + color_right[1] * t)
        b = int(color_left[2] * (1 - t) + color_right[2] * t)
        draw.line([(x, 0), (x, H)], fill=(r, g, b, 255))
        
    return canvas

def apply_gradient_blend(source_img, target_w, target_h, fade_width=180):
    """Resizes the square source image and applies a smooth linear alpha mask on the left."""
    resized = source_img.resize((target_w, target_h), Image.Resampling.LANCZOS).convert("RGBA")
    
    mask = Image.new("L", (target_w, target_h), 255)
    mask_draw = ImageDraw.Draw(mask)
    
    for x in range(fade_width):
        alpha = int(255 * (x / fade_width))
        mask_draw.line([(x, 0), (x, target_h)], fill=alpha)
        
    resized.putalpha(ImageChops.multiply(resized.getchannel("A"), mask))
    return resized

def draw_text_overlay(draw, badge_text, title_text, subtitle_text, accent_color=(255, 26, 117, 255)):
    """Draws a beautiful, professional, high-end e-commerce text overlay on the left side of the canvas."""
    badge_x, badge_y = 120, 140
    badge_pad_h, badge_pad_v = 16, 8
    
    bbox = badge_font.getbbox(badge_text)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    
    badge_w = tw + badge_pad_h * 2
    badge_h = th + badge_pad_v * 2
    
    # Draw pill badge
    draw.rounded_rectangle(
        [badge_x, badge_y, badge_x + badge_w, badge_y + badge_h],
        radius=14,
        fill=accent_color
    )
    
    draw.text(
        (badge_x + badge_pad_h, badge_y + badge_pad_v),
        badge_text,
        font=badge_font,
        fill=(255, 255, 255, 255)
    )
    
    # Title
    title_x, title_y = 120, 195
    draw.text(
        (title_x, title_y),
        title_text,
        font=title_font,
        fill=(26, 26, 26, 255)
    )
    
    # Subtitle
    subtitle_x, subtitle_y = 120, 285
    draw.text(
        (subtitle_x, subtitle_y),
        subtitle_text,
        font=subtitle_font,
        fill=(74, 74, 74, 255)
    )
    
    # Bottom accent line
    draw.rounded_rectangle(
        [120, 340, 220, 345],
        radius=3,
        fill=accent_color
    )

# Vertical dimensions (440px high centered in 600px canvas)
target_h = 440
y_offset = 80
x_pos = 1050

# ==========================================
# BANNER 1: Casa & Cozinha (Coffee Maker)
# ==========================================
print("Compiling Banner 1: Casa & Cozinha...")
cafe_square_path = os.path.join(brain_dir, "nessa_banner_casa_square_1780067991334.png")
if os.path.exists(cafe_square_path):
    img_cafe = Image.open(cafe_square_path)
    cropped_cafe = img_cafe.crop((180, 150, 1024, 1024))
    
    # Exact kitchen background pink/white colors
    c_left = (251, 201, 211)   # Luxury kitchen pink
    c_right = (254, 235, 239)  # Soft pink-white
    
    canvas = create_base_canvas(c_left, c_right)
    draw = ImageDraw.Draw(canvas)
    
    # Rescaled coffee scene
    blended_cafe = apply_gradient_blend(cropped_cafe, target_h, target_h, fade_width=180)
    canvas.paste(blended_cafe, (x_pos, y_offset), blended_cafe)
    
    # Text overlay with matching hot pink accent
    draw_text_overlay(draw, "COZINHA CHARMOSA ☕", "Cafeteira Britânia Rosa", "Seu dia começa mais doce e cheio de estilo")
    
    canvas.convert("RGB").save(os.path.join(images_dir, "banner_casa.png"), "PNG")
    print("Banner 1 saved successfully!")

# ==========================================
# BANNER 2: Organização (Vacuum Cleaner)
# ==========================================
print("Compiling Banner 2: Organização...")
vacuum_square_path = os.path.join(brain_dir, "nessa_banner_organizacao_square_1780068026605.png")
if os.path.exists(vacuum_square_path):
    img_vacuum = Image.open(vacuum_square_path)
    cropped_vacuum = img_vacuum.crop((180, 80, 900, 1024))
    
    # Exact living room blue-grey/white colors
    c_left = (192, 208, 217)   # Luxury wall grey-blue
    c_right = (227, 235, 240)  # Light grey-white
    
    canvas = create_base_canvas(c_left, c_right)
    draw = ImageDraw.Draw(canvas)
    
    orig_w, orig_h = cropped_vacuum.size
    target_w = int(orig_w * (target_h / orig_h))
    
    blended_vacuum = apply_gradient_blend(cropped_vacuum, target_w, target_h, fade_width=150)
    canvas.paste(blended_vacuum, (x_pos, y_offset), blended_vacuum)
    
    # Text overlay with matching deep rose/blue-pink accent
    draw_text_overlay(draw, "CASA IMPECÁVEL 🧹", "Aspirador Vertical Rosa", "Praticidade e rapidez para a limpeza do dia a dia", accent_color=(235, 20, 100, 255))
    
    canvas.convert("RGB").save(os.path.join(images_dir, "banner_tech.png"), "PNG")
    # Also save as banner_organizacao.png for clean category mapping
    canvas.convert("RGB").save(os.path.join(images_dir, "banner_organizacao.png"), "PNG")
    print("Banner 2 saved successfully!")

# ==========================================
# BANNER 3: Eletrônicos (Table Fan)
# ==========================================
print("Compiling Banner 3: Eletrônicos...")
fan_square_path = os.path.join(brain_dir, "nessa_ventilador_banner_wide_1780067127163.png")
if os.path.exists(fan_square_path):
    img_fan = Image.open(fan_square_path)
    cropped_fan = img_fan.crop((200, 0, 1024, 1024))
    
    # Exact breezy room white-grey colors
    c_left = (235, 234, 235)   # Clean room grey
    c_right = (250, 249, 250)  # Pure fresh white
    
    canvas = create_base_canvas(c_left, c_right)
    draw = ImageDraw.Draw(canvas)
    
    blended_fan = apply_gradient_blend(cropped_fan, target_h, target_h, fade_width=160)
    canvas.paste(blended_fan, (x_pos, y_offset), blended_fan)
    
    # Text overlay with matching cool pink accent
    draw_text_overlay(draw, "REFRESCO E CONFORTO 💨", "Ventilador Super Power", "Vento forte e design elegante para os dias quentes", accent_color=(255, 40, 130, 255))
    
    canvas.convert("RGB").save(os.path.join(images_dir, "banner_beleza.png"), "PNG")
    # Also save as banner_eletronicos.png
    canvas.convert("RGB").save(os.path.join(images_dir, "banner_eletronicos.png"), "PNG")
    print("Banner 3 saved successfully!")

print("All 3 photorealistic widescreen banners re-centered and compiled successfully!")
