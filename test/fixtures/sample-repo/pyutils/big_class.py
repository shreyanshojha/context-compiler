class ReportBuilder:
    """Builds a formatted report from raw records."""

    default_width = 80

    def __init__(self, records):
        self.records = records
        self.lines = []

    @staticmethod
    def normalize(record):
        return {k: str(v).strip() for k, v in record.items()}

    @property
    def row_count(self):
        return len(self.records)

    def add_header(self, title):
        self.lines.append(title.center(self.default_width))
        self.lines.append("-" * self.default_width)

    def add_row(self, record):
        normalized = self.normalize(record)
        self.lines.append(", ".join(f"{k}={v}" for k, v in normalized.items()))

    async def add_row_async(self, record):
        normalized = self.normalize(record)
        self.lines.append(", ".join(f"{k}={v}" for k, v in normalized.items()))
        return True

    def build(self):
        self.add_header("Report")
        for record in self.records:
            self.add_row(record)
        return "\n".join(self.lines)

    class Formatter:
        """Nested helper the outer class delegates rendering to."""

        def __init__(self, width):
            self.width = width

        def pad(self, text):
            return text.ljust(self.width)

        def render(self, lines):
            return "\n".join(self.pad(line) for line in lines)
