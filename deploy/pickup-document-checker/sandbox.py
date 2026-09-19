"""Check one untrusted pickup document inside a disposable, networkless container."""
import hashlib
import io
import json
import re
from pathlib import Path
import subprocess
import sys
import time
import zipfile

MAX_SOURCE = 25 * 1024 * 1024
MAX_EXPANDED = 128 * 1024 * 1024
MIMES = {
    'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg',
    'application/msword': 'doc', 'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
}


class Rejected(Exception):
    pass


def command(args, timeout=35):
    with open('/work/command.log', 'w+b') as log:
        try:
            result = subprocess.run(args, stdout=log, stderr=log, timeout=timeout, check=False)
        except (OSError, subprocess.TimeoutExpired):
            raise Rejected('SCANNER_UNAVAILABLE')
        log.seek(0)
        output = log.read(4096).decode('utf-8', 'replace').strip()
    if result.returncode == 1:
        raise Rejected('INVALID')
    if result.returncode != 0:
        raise Rejected('SCANNER_UNAVAILABLE')
    return output


def check_zip(data, ext):
    from defusedxml import ElementTree as XML
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        expected = 'word/document.xml' if ext == 'docx' else 'xl/workbook.xml'
        if len(entries) > 2000 or sum(entry.file_size for entry in entries) > MAX_EXPANDED:
            raise Rejected('LIMIT')
        if len(names) != len(set(names)) or expected not in names or '[Content_Types].xml' not in names:
            raise Rejected('INVALID')
        for entry in entries:
            name = entry.filename.lower()
            if entry.flag_bits & 1 or entry.file_size > 32 * 1024 * 1024:
                raise Rejected('LIMIT')
            if any(part in name for part in ('vbaproject', 'activex', 'embeddings/', 'externallinks/', 'connections.xml')):
                raise Rejected('ACTIVE_CONTENT')
            contents = archive.read(entry)
            if name.endswith(('.xml', '.rels')):
                tree = XML.fromstring(contents)
                field_parts = []
                for node in tree.iter():
                    local = node.tag.rsplit('}', 1)[-1].lower()
                    if local == 'instrtext':
                        field_parts.append(node.text or '')
                    elif local == 'fldsimple':
                        field_parts.append(' ' + ' '.join(node.attrib.values()) + ' ')
                    elif local == 'fldchar':
                        field_parts.append(' ')
                    elif local == 'relationship' and node.attrib.get('TargetMode', '').lower() == 'external' and not node.attrib.get('Type', '').endswith('/hyperlink'):
                        raise Rejected('ACTIVE_CONTENT')
                if re.search(r'\b(?:DDEAUTO|DDE|INCLUDETEXT|INCLUDEPICTURE|DATABASE|LINK)\b', ''.join(field_parts), re.I):
                    raise Rejected('ACTIVE_CONTENT')


def check_ole(data, ext):
    import olefile
    with olefile.OleFileIO(io.BytesIO(data), raise_defects=olefile.DEFECT_INCORRECT) as ole:
        streams = ole.listdir()
        names = ['/'.join(parts).lower() for parts in streams]
        required = 'worddocument' if ext == 'doc' else 'workbook'
        if len(streams) > 2000 or required not in names:
            raise Rejected('INVALID')
        expanded = 0
        for parts, name in zip(streams, names):
            if any(part in name for part in ('vba', 'macros', 'encryptedpackage', 'encryptioninfo', 'objectpool')):
                raise Rejected('ACTIVE_CONTENT')
            expanded += ole.get_size(parts)
            if expanded > MAX_EXPANDED:
                raise Rejected('LIMIT')
            stream = ole.openstream(parts)
            if len(stream.read(ole.get_size(parts) + 1)) != ole.get_size(parts):
                raise Rejected('INVALID')


def check_pdf(path):
    import pikepdf
    with pikepdf.open(path, attempt_recovery=False) as pdf:
        if pdf.is_encrypted or len(pdf.pages) < 1:
            raise Rejected('INVALID')
        syntax_check = getattr(pdf, 'check_pdf_syntax', None) or pdf.check
        if syntax_check():
            raise Rejected('INVALID')
        expanded = 0
        for obj in pdf.objects:
            if isinstance(obj, (pikepdf.Dictionary, pikepdf.Stream)):
                if any(key in obj for key in ('/JS', '/JavaScript', '/AA', '/OpenAction', '/EmbeddedFiles', '/XFA')):
                    raise Rejected('ACTIVE_CONTENT')
                if str(obj.get('/S', '')) in ('/Launch', '/JavaScript', '/GoToR', '/SubmitForm', '/ImportData'):
                    raise Rejected('ACTIVE_CONTENT')
            if isinstance(obj, pikepdf.Stream):
                expanded += len(obj.read_bytes(pikepdf.StreamDecodeLevel.all))
                if expanded > MAX_EXPANDED:
                    raise Rejected('LIMIT')


def check_office(path, ext):
    import uno
    import unohelper
    from com.sun.star.beans import PropertyValue
    from com.sun.star.task import XInteractionHandler

    class RejectInteraction(unohelper.Base, XInteractionHandler):
        def handle(self, request):
            for continuation in request.getContinuations():
                if hasattr(continuation, 'abort'):
                    continuation.abort()
            raise Rejected('INVALID')

    def prop(name, value):
        value_prop = PropertyValue()
        value_prop.Name, value_prop.Value = name, value
        return value_prop

    process = subprocess.Popen(['soffice', '-env:UserInstallation=file:///work/profile', '--headless', '--nologo', '--nodefault',
                                '--nofirststartwizard', '--accept=socket,host=127.0.0.1,port=2002;urp;StarOffice.ComponentContext'],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    document = None
    try:
        local = uno.getComponentContext()
        resolver = local.ServiceManager.createInstanceWithContext('com.sun.star.bridge.UnoUrlResolver', local)
        context = None
        for _ in range(100):
            try:
                context = resolver.resolve('uno:socket,host=127.0.0.1,port=2002;urp;StarOffice.ComponentContext')
                break
            except Exception:
                if process.poll() is not None:
                    raise Rejected('INVALID')
                time.sleep(0.05)
        if context is None:
            raise Rejected('INVALID')
        desktop = context.ServiceManager.createInstanceWithContext('com.sun.star.frame.Desktop', context)
        document = desktop.loadComponentFromURL(path.as_uri(), '_blank', 0, (
            prop('Hidden', True), prop('ReadOnly', True), prop('MacroExecutionMode', 0), prop('UpdateDocMode', 0),
            prop('InteractionHandler', RejectInteraction()),
        ))
        service = 'com.sun.star.text.TextDocument' if ext in ('doc', 'docx') else 'com.sun.star.sheet.SpreadsheetDocument'
        if document is None or not document.supportsService(service):
            raise Rejected('INVALID')
        if ext in ('doc', 'docx'):
            fields = document.getTextFields().createEnumeration()
            allowed = ('PageNumber', 'PageCount', 'DateTime', 'Author', 'FileName')
            while fields.hasMoreElements():
                field = fields.nextElement()
                if not any(field.supportsService('com.sun.star.text.' + group + '.' + name) for group in ('textfield', 'TextField') for name in allowed):
                    raise Rejected('ACTIVE_CONTENT')
    finally:
        if document is not None:
            document.close(True)
        process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()


def inspect(data, content_type, expected_hash):
    ext = MIMES[content_type]
    if ext == 'xls':
        # OLE stream names do not reveal XLM/DDE/external-link behaviour reliably.
        raise Rejected('SCANNER_UNAVAILABLE')
    if not 0 <= time.time() - int(Path('/opt/signatures-built-at').read_text()) <= 7 * 86400:
        raise Rejected('SCANNER_UNAVAILABLE')
    path = Path('/work/source.' + ext)
    path.write_bytes(data)
    scan = command(['clamscan', '--no-summary', '--alert-exceeds-max=yes', '--alert-encrypted=yes', '--max-scansize=128M',
                    '--max-filesize=50M', '--max-files=2000', '--max-recursion=16', '--tempdir=/work', str(path)])
    if not scan.endswith(': OK'):
        raise Rejected('INVALID')
    scanner_version = command(['clamscan', '--version'])[:200]
    metadata = {'scannerVersion': scanner_version, 'signatureVersion': scanner_version,
                'packageSetSha256': hashlib.sha256(Path('/opt/package-versions.txt').read_bytes()).hexdigest()}
    if ext in ('docx', 'xlsx'):
        check_zip(data, ext)
    elif ext == 'doc':
        check_ole(data, ext)
    if ext in ('doc', 'docx', 'xlsx'):
        check_office(path, ext)
    elif ext == 'pdf':
        check_pdf(path)
    else:
        from PIL import Image
        Image.MAX_IMAGE_PIXELS = 25_000_000
        with Image.open(path) as image:
            if image.format != ('PNG' if ext == 'png' else 'JPEG') or getattr(image, 'n_frames', 1) != 1:
                raise Rejected('INVALID')
            image.verify()
        with Image.open(path) as image:
            image.load()
    if hashlib.sha256(data).hexdigest() != expected_hash:
        raise Rejected('INVALID')
    return metadata


def main():
    header = sys.stdin.buffer.readline(8193)
    request = {}
    reply = {'protocol': 1, 'sourceSha256': '', 'contentType': '', 'clean': False, 'validated': False}
    try:
        if len(header) > 8192:
            raise Rejected('INVALID')
        request = json.loads(header)
        content_type = request.get('contentType')
        digest = request.get('sha256')
        reply.update(sourceSha256=digest if isinstance(digest, str) else '', contentType=content_type if isinstance(content_type, str) else '')
        if request.get('protocol') != 1 or request.get('mode') != 'check' or content_type not in MIMES:
            raise Rejected('INVALID')
        size = request.get('byteSize')
        if type(size) is not int or not 0 < size <= MAX_SOURCE or not isinstance(digest, str) or not re.fullmatch(r'[a-f0-9]{64}', digest):
            raise Rejected('LIMIT')
        data = sys.stdin.buffer.read(size + 1)
        if len(data) != size or hashlib.sha256(data).hexdigest() != digest:
            raise Rejected('INVALID')
        reply.update(inspect(data, content_type, digest))
        reply.update(clean=True, validated=True)
    except Rejected as error:
        reply.update(clean=False, validated=False, errorCode=str(error))
    except Exception:
        reply.update(clean=False, validated=False, errorCode='INVALID')
    sys.stdout.buffer.write(json.dumps(reply, separators=(',', ':')).encode() + b'\n')


if __name__ == '__main__':
    main()
