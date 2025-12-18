import os
from bs4 import BeautifulSoup
from supabase import create_client
from dotenv import load_dotenv # pip install python-dotenv

# Last inn variabler fra .env
load_dotenv()

# Supabase konfigurasjon - hentes fra miljøvariabler (.env / runtime env)
SUPABASE_URL = os.environ.get("SUPABASE_URL")
print(SUPABASE_URL)
SUPABASE_KEY = os.environ.get("SUPABASE_SECRET_KEY")  # Må være service_role for å skrive til DB
supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

def is_main_law(soup):
    """
    Sjekker om dette er en hovedlov.
    Hovedlover har IKKE <dt class="changesToDocuments">.
    """
    return soup.find('dt', class_='changesToDocuments') is None

def parse_xml_file(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        # Bruker lxml-xml for å håndtere store filer raskt og korrekt
        soup = BeautifulSoup(f, 'lxml-xml')

    # 1. Filtrer bort endringslover (vi vil kun ha grunnmuren)
    if not is_main_law(soup):
        # print(f"Hopper over endringslov: {os.path.basename(filepath)}")
        return None

    # Hjelpefunksjon for å hente metadata fra Lovdatas definisjonslister
    def get_meta(class_name):
        tag = soup.find('dt', class_=class_name)
        if tag and tag.find_next_sibling('dd'):
            return tag.find_next_sibling('dd').get_text(strip=True)
        return None

    dokid = get_meta('dokid')
    if not dokid:
        return None

    # 2. Bestem dokumenttype
    # Basert på dine ENUMs: 'lov', 'forskrift_sentral', 'forskrift_lokal'
    doc_type = 'lov'
    if 'lov' not in dokid.lower():
        doc_type = 'forskrift_lokal' if 'ltii' in dokid.lower() else 'forskrift_sentral'

    # 3. Pakk dataene for Supabase
    data = {
        "dokid": dokid,
        "legacy_id": get_meta('legacyID'), # F.eks. LOV-1884-06-14-3
        "title": soup.find('title').get_text(strip=True) if soup.find('title') else "Mangler tittel",
        "short_title": get_meta('titleShort'),
        "document_type": doc_type
    }
    
    return data

def run_import(folder_path):
    print(f"Starter import fra: {folder_path}...")
    success_count = 0
    skip_count = 0
    
    # Gå gjennom alle filer i mappen
    for filename in os.listdir(folder_path):
        if filename.endswith('.xml'):
            filepath = os.path.join(folder_path, filename)
            try:
                doc_data = parse_xml_file(filepath)
                
                if doc_data:
                    # Bruker upsert så vi ikke får feil om vi kjører scriptet to ganger
                    supabase.table("legal_documents").upsert(doc_data).execute()
                    print(f"Importert: {doc_data['short_title'] or doc_data['title'][:40]}")
                    success_count += 1
                else:
                    skip_count += 1
            except Exception as e:
                print(f"FEIL i fil {filename}: {e}")
    
    print("-" * 30)
    print(f"Import ferdig!")
    print(f"Hovedlover lagt til: {success_count}")
    print(f"Endringslover hoppet over: {skip_count}")

if __name__ == "__main__":
    # Sett stien til mappen der du har lagret alle .xml filene
    PATH_TO_XML_FOLDER = "./nl" 
    run_import(PATH_TO_XML_FOLDER)