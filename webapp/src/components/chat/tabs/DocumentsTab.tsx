// Copyright (c) Microsoft. All rights reserved.

import {
    Button,
    Label,
    ProgressBar,
    Radio,
    RadioGroup,
    Spinner,
    Table,
    TableBody,
    TableCell,
    TableCellLayout,
    TableColumnDefinition,
    TableColumnId,
    TableHeader,
    TableHeaderCell,
    TableHeaderCellProps,
    TableRow,
    Tooltip,
    createTableColumn,
    makeStyles,
    shorthands,
    tokens,
    useTableFeatures,
    useTableSort,
} from '@fluentui/react-components';
import {
    DocumentArrowUp20Regular,
    DocumentPdfRegular,
    DocumentTextRegular,
    FluentIconsProps,
} from '@fluentui/react-icons';
import * as React from 'react';
import { useRef } from 'react';
import { useDispatch } from 'react-redux';
import { useChat } from '../../../libs/hooks';
import { ChatMemorySource } from '../../../libs/models/ChatMemorySource';
import { useAppSelector } from '../../../redux/app/hooks';
import { RootState } from '../../../redux/app/store';
import { setImportingDocumentsToConversation } from '../../../redux/features/conversations/conversationsSlice';
import { timestampToDateString } from '../../utils/TextUtils';
import { TabView } from './TabView';

const EmptyGuid = '00000000-0000-0000-0000-000000000000';

const useClasses = makeStyles({
    functional: {
        display: 'flex',
        flexDirection: 'row',
        ...shorthands.margin('0', '0', tokens.spacingVerticalS, '0'),
    },
    uploadButton: {
        ...shorthands.margin('0', tokens.spacingHorizontalS, '0', '0'),
    },
    vectorDatabase: {
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'baseline',
        marginLeft: 'auto',
        ...shorthands.gap(tokens.spacingHorizontalSNudge),
    },
    table: {
        backgroundColor: tokens.colorNeutralBackground1,
    },
    tableHeader: {
        fontWeight: tokens.fontSizeBase600,
    },
});

interface TableItem {
    id: string;
    chatId: string;
    name: {
        label: string;
        icon: JSX.Element;
        url?: string;
    };
    createdOn: {
        label: string;
        timestamp: number;
    };
    tokens: number;
}

export const DocumentsTab: React.FC = () => {
    const classes = useClasses();
    const chat = useChat();
    const dispatch = useDispatch();
    const { serviceOptions } = useAppSelector((state: RootState) => state.app);
    const { conversations, selectedId } = useAppSelector((state: RootState) => state.conversations);
    const { importingDocuments } = conversations[selectedId];

    const [resources, setResources] = React.useState<ChatMemorySource[]>([]);
    const documentFileRef = useRef<HTMLInputElement | null>(null);

    React.useEffect(() => {
        const importingResources = importingDocuments
            ? importingDocuments.map((document, index) => {
                  return {
                      id: `in-progress-${index}`,
                      chatId: selectedId,
                      sourceType: 'N/A',
                      name: document,
                      sharedBy: 'N/A',
                      createdOn: 0,
                      tokens: 0,
                  } as ChatMemorySource;
              })
            : [];
        setResources(importingResources);

        void chat.getChatMemorySources(selectedId).then((sources) => {
            setResources([...importingResources, ...sources]);
        });

        // We don't want to have chat as one of the dependencies as it will cause infinite loop.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [importingDocuments, selectedId]);

    const handleImport = () => {
        const files = documentFileRef.current?.files;

        if (files && files.length > 0) {
            // Deep copy the FileList into an array so that the function
            // maintains a list of files to import before the import is complete.
            const filesArray = Array.from(files);

            dispatch(
                setImportingDocumentsToConversation({
                    importingDocuments: filesArray.map((file) => file.name),
                    chatId: selectedId,
                }),
            );

            void chat.importDocument(selectedId, filesArray).finally(() => {
                dispatch(
                    setImportingDocumentsToConversation({
                        importingDocuments: [],
                        chatId: selectedId,
                    }),
                );
            });
        }

        // Reset the file input so that the onChange event will
        // be triggered even if the same file is selected again.
        if (documentFileRef.current?.value) {
            documentFileRef.current.value = '';
        }
    };

    const { columns, rows } = useTable(resources);
    return (
        <TabView
            title="Documents"
            learnMoreDescription="document embeddings"
            learnMoreLink="https://aka.ms/sk-docs-vectordb"
        >
            <div className={classes.functional}>
                {/* Hidden input for file upload. Only accept .txt and .pdf files for now. */}
                <input
                    type="file"
                    ref={documentFileRef}
                    style={{ display: 'none' }}
                    accept=".txt,.pdf,.md,.jpg,.jpeg,.png,.tif,.tiff"
                    multiple={true}
                    onChange={handleImport}
                />
                <Tooltip content="Embed file into chat session" relationship="label">
                    <Button
                        className={classes.uploadButton}
                        icon={<DocumentArrowUp20Regular />}
                        disabled={importingDocuments && importingDocuments.length > 0}
                        onClick={() => documentFileRef.current?.click()}
                    >
                        Upload
                    </Button>
                </Tooltip>
                {importingDocuments && importingDocuments.length > 0 && <Spinner size="tiny" />}
                {/* Hardcode vector database as we don't support switching vector store dynamically now. */}
                <div className={classes.vectorDatabase}>
                    <Label size="large">Vector Database</Label>
                    <RadioGroup defaultValue={serviceOptions.memoriesStore.selectedType} layout="horizontal">
                        {serviceOptions.memoriesStore.types.map((storeType) => {
                            return (
                                <Radio
                                    key={storeType}
                                    value={storeType}
                                    label={storeType}
                                    disabled={storeType !== serviceOptions.memoriesStore.selectedType}
                                />
                            );
                        })}
                    </RadioGroup>
                </div>
            </div>
            <Table aria-label="External resource table" className={classes.table}>
                <TableHeader>
                    <TableRow>{columns.map((column) => column.renderHeaderCell())}</TableRow>
                </TableHeader>
                <TableBody>
                    {rows.map((item) => (
                        <TableRow key={item.id}>{columns.map((column) => column.renderCell(item))}</TableRow>
                    ))}
                </TableBody>
            </Table>
        </TabView>
    );
};

function useTable(resources: ChatMemorySource[]) {
    const headerSortProps = (columnId: TableColumnId): TableHeaderCellProps => ({
        onClick: (e: React.MouseEvent) => {
            toggleColumnSort(e, columnId);
        },
        sortDirection: getSortDirection(columnId),
    });

    const columns: Array<TableColumnDefinition<TableItem>> = [
        createTableColumn<TableItem>({
            columnId: 'name',
            renderHeaderCell: () => (
                <TableHeaderCell key="name" {...headerSortProps('name')}>
                    Name
                </TableHeaderCell>
            ),
            renderCell: (item) => (
                <TableCell key={item.id}>
                    <TableCellLayout media={item.name.icon}>
                        <a href={item.name.url}>{item.name.label}</a>
                    </TableCellLayout>
                </TableCell>
            ),
            compare: (a, b) => {
                const comparison = a.name.label.localeCompare(b.name.label);
                return getSortDirection('name') === 'ascending' ? comparison : comparison * -1;
            },
        }),
        createTableColumn<TableItem>({
            columnId: 'createdOn',
            renderHeaderCell: () => (
                <TableHeaderCell key="createdOn" {...headerSortProps('createdOn')}>
                    Created on
                </TableHeaderCell>
            ),
            renderCell: (item) => (
                <TableCell key={item.createdOn.timestamp} title={new Date(item.createdOn.timestamp).toLocaleString()}>
                    {item.id.startsWith('in-progress') ? 'N/A' : item.createdOn.label}
                </TableCell>
            ),
            compare: (a, b) => {
                const comparison = a.createdOn.timestamp > b.createdOn.timestamp ? 1 : -1;
                return getSortDirection('createdOn') === 'ascending' ? comparison : comparison * -1;
            },
        }),
        createTableColumn<TableItem>({
            columnId: 'tokenCounts',
            renderHeaderCell: () => (
                <TableHeaderCell key="tokenCounts" {...headerSortProps('tokenCounts')}>
                    Token Count
                </TableHeaderCell>
            ),
            renderCell: (item) => (
                <TableCell key={`${item.id}-tokens`}>
                    {item.id.startsWith('in-progress') ? 'N/A' : item.tokens}
                </TableCell>
            ),
            compare: (a, b) => {
                const aAccess = getAccessString(a.chatId);
                const bAccess = getAccessString(b.chatId);
                const comparison = aAccess.localeCompare(bAccess);
                return getSortDirection('tokenCounts') === 'ascending' ? comparison : comparison * -1;
            },
        }),
        createTableColumn<TableItem>({
            columnId: 'access',
            renderHeaderCell: () => (
                <TableHeaderCell key="access" {...headerSortProps('access')}>
                    Access
                </TableHeaderCell>
            ),
            renderCell: (item) => (
                <TableCell key={`${item.id} ${item.name.label}`}>{getAccessString(item.chatId)}</TableCell>
            ),
            compare: (a, b) => {
                const aAccess = getAccessString(a.chatId);
                const bAccess = getAccessString(b.chatId);
                const comparison = aAccess.localeCompare(bAccess);
                return getSortDirection('access') === 'ascending' ? comparison : comparison * -1;
            },
        }),
        createTableColumn<TableItem>({
            columnId: 'progress',
            renderHeaderCell: () => (
                <TableHeaderCell key="progress" {...headerSortProps('progress')}>
                    Progress
                </TableHeaderCell>
            ),
            renderCell: (item) => (
                <TableCell key={`${item.id}-progress`}>
                    <ProgressBar
                        max={1}
                        value={item.id.startsWith('in-progress') ? undefined : 1} // Hack: tokens stores the progress bar percentage.
                        shape="rounded"
                        thickness="large"
                        color={item.id.startsWith('in-progress') ? 'brand' : 'success'}
                    />
                </TableCell>
            ),
            compare: (a, b) => {
                const aAccess = getAccessString(a.chatId);
                const bAccess = getAccessString(b.chatId);
                const comparison = aAccess.localeCompare(bAccess);
                return getSortDirection('progress') === 'ascending' ? comparison : comparison * -1;
            },
        }),
    ];

    const items = resources.map((item) => ({
        id: item.id,
        chatId: item.chatId,
        name: {
            label: item.name,
            icon: getFileIconByFileExtension(item.name),
            url: item.hyperlink,
        },
        createdOn: {
            label: timestampToDateString(item.createdOn),
            timestamp: item.createdOn,
        },
        tokens: item.tokens,
    }));

    const {
        sort: { getSortDirection, toggleColumnSort, sortColumn },
    } = useTableFeatures(
        {
            columns,
            items,
        },
        [
            useTableSort({
                defaultSortState: { sortColumn: 'createdOn', sortDirection: 'descending' },
            }),
        ],
    );

    if (sortColumn) {
        items.sort((a, b) => {
            const compare = columns.find((column) => column.columnId === sortColumn)?.compare;
            return compare?.(a, b) ?? 0;
        });
    }

    return { columns, rows: items };
}

function getAccessString(chatId: string) {
    return chatId === EmptyGuid ? 'Global' : 'This chat';
}

export function getFileIconByFileExtension(fileName: string, props: FluentIconsProps = {}) {
    const extension = fileName.toLowerCase().substring(fileName.lastIndexOf('.') + 1);
    if (extension === 'pdf') {
        return <DocumentPdfRegular {...props} />;
    }
    return <DocumentTextRegular {...props} />;
}
