import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { RemoteCalls } from '@oryh/dsh-connection'
import {
  type ChatFormReceipt,
  type ChatFormRecords,
  type ChatFormRecordsRequest,
  type ChatFormSubmitRequest,
  type CustomAskRequest,
  type CustomFormConfirm,
  type CustomFormPreview,
  type CustomFormReceipt,
  type CustomFormRequest,
  type CustomIdRequest,
  type CustomMigrationReport,
  type CustomPage,
  type CustomPageSummary,
  type CustomRequest,
  type CustomRunRequest,
  type CustomSaveRequest,
} from './custom-model.js'
import type { CustomPageService } from './custom-service.js'
import type { AnalysisService } from './service.js'
import type {
  AnalysisDocument,
  AnalysisIdRequest,
  AnalysisPreviewRequest,
  AnalysisRequest,
  AnalysisResult,
  AnalysisSaveRequest,
  AnalysisView,
} from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    oryhAnalytics: AnalysisService
    oryhAnalyticsRemote: AnalyticsRemote
    oryhCustomPages: CustomPageService
  }
}
export class AnalyticsRemote extends TypertRemoteService {
  static inject = ['typert', 'oryhAnalytics']
  private readonly calls: RemoteCalls
  constructor(ctx: Context) {
    super(ctx, 'oryhAnalyticsRemote', { namespace: 'oryhAnalytics' })
    this.calls = new RemoteCalls(ctx, 'oryhAnalytics')
  }
  @Remote('list') list(r: AnalysisRequest): Promise<AnalysisDocument[]> {
    return this.calls.call(() => this.ctx.oryhAnalytics.list(r))
  }
  @Remote('load') load(r: AnalysisIdRequest): Promise<AnalysisView> {
    return this.calls.call(() => this.ctx.oryhAnalytics.load(r))
  }
  @Remote('preview') preview(r: AnalysisPreviewRequest): Promise<AnalysisResult> {
    return this.calls.call(() => this.ctx.oryhAnalytics.preview(r))
  }
  @Remote('save') save(r: AnalysisSaveRequest): Promise<AnalysisView> {
    return this.calls.call(() => this.ctx.oryhAnalytics.save(r))
  }
  @Remote('customList') customList(r: CustomRequest): Promise<CustomPageSummary[]> {
    return this.calls.call(() => this.ctx.oryhCustomPages.listSummaries(r))
  }
  @Remote('customLoad') customLoad(r: CustomIdRequest): Promise<CustomPage> {
    return this.calls.call(() => this.ctx.oryhCustomPages.load(r))
  }
  @Remote('customSave') customSave(r: CustomSaveRequest): Promise<CustomPage> {
    return this.calls.call(() => this.ctx.oryhCustomPages.save(r))
  }
  @Remote('customRun') customRun(r: CustomRunRequest): Promise<CustomPage> {
    return this.calls.call(() => this.ctx.oryhCustomPages.run(r))
  }
  @Remote('customCancel') customCancel(r: CustomIdRequest): Promise<void> {
    return this.calls.call(() => this.ctx.oryhCustomPages.cancel(r))
  }
  @Remote('customRestore') customRestore(r: CustomRunRequest): Promise<CustomPage> {
    return this.calls.call(() => this.ctx.oryhCustomPages.restore(r))
  }
  @Remote('customDelete') customDelete(r: CustomRunRequest): Promise<void> {
    return this.calls.call(() => this.ctx.oryhCustomPages.delete(r))
  }
  @Remote('customFormPreview') customFormPreview(r: CustomFormRequest): Promise<CustomFormPreview> {
    return this.calls.call(() => this.ctx.oryhCustomPages.previewForm(r))
  }
  @Remote('customFormSubmit') customFormSubmit(r: CustomFormConfirm): Promise<CustomFormReceipt> {
    return this.calls.call(() => this.ctx.oryhCustomPages.submitForm(r))
  }
  @Remote('customAsk') customAsk(r: CustomAskRequest): Promise<void> {
    return this.calls.call(() => this.ctx.oryhCustomPages.ask(r))
  }
  @Remote('chatFormSubmit') chatFormSubmit(r: ChatFormSubmitRequest): Promise<ChatFormReceipt> {
    return this.calls.call(() => this.ctx.oryhCustomPages.submitChatForm(r))
  }
  @Remote('chatFormRecords') chatFormRecords(r: ChatFormRecordsRequest): Promise<ChatFormRecords> {
    return this.calls.call(() =>
      this.ctx.oryhCustomPages.recordLookup(
        r.sessionId,
        { collection: r.collection, label: r.label, ...(r.code ? { code: r.code } : {}) },
        { query: r.query, page: r.page },
      ),
    )
  }
  @Remote('customMigrate') customMigrate(r: CustomRequest): Promise<CustomMigrationReport> {
    return this.calls.call(async () => this.ctx.oryhCustomPages.migrate(r, await this.ctx.oryhAnalytics.list(r)))
  }
}
