import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import {
  MAT_DIALOG_DATA,
  MatDialogActions,
  MatDialogContent,
  MatDialogRef,
  MatDialogTitle,
} from '@angular/material/dialog';
import { T } from 'src/app/t.const';
import { DialogConflictResolutionResult } from '../sync.model';
import { ConflictData } from '../../../pfapi/api';
import { MatButton } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import { DatePipe } from '@angular/common';

@Component({
  selector: 'dialog-sync-conflict',
  templateUrl: './dialog-sync-conflict.component.html',
  styleUrls: ['./dialog-sync-conflict.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatDialogTitle,
    MatDialogContent,
    MatDialogActions,
    MatButton,
    MatIcon,
    TranslatePipe,
    DatePipe,
  ],
})
export class DialogSyncConflictComponent {
  private _matDialogRef = inject<MatDialogRef<DialogSyncConflictComponent>>(MatDialogRef);
  data = inject<ConflictData>(MAT_DIALOG_DATA);

  T: typeof T = T;

  remoteDate: number = this.data.remote.lastUpdate;
  localDate: number = this.data.local.lastUpdate;
  lastDate: number | null = this.data.local.lastSyncedUpdate;

  remoteTime: number = this.data.remote.lastUpdate;
  localTime: number = this.data.local.lastUpdate;
  lastTime: number | null = this.data.local.lastSyncedUpdate;

  remoteLamport: number = this.data.remote.localLamport;
  localLamport: number = this.data.local.localLamport;
  lastSyncedLamport: number | null = this.data.local.lastSyncedLamport;

  isHighlightRemote: boolean = this.data.remote.lastUpdate >= this.data.local.lastUpdate;
  isHighlightLocal: boolean = this.data.local.lastUpdate >= this.data.remote.lastUpdate;

  constructor() {
    const _matDialogRef = this._matDialogRef;

    _matDialogRef.disableClose = true;
  }

  close(res?: DialogConflictResolutionResult): void {
    this._matDialogRef.close(res);
  }
}
