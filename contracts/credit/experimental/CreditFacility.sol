// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {CreditConfig, CreditRecord, ReceivableInfo, FacilityConfig, ReceivableState} from "../CreditStructs.sol";
import {ReceivableCredit_old} from "../deprecated/ReceivableCredit_old.sol";
import {ICreditFacility} from "../interfaces/experimental/ICreditFacility.sol";
import {Receivable} from "../Receivable.sol";
import {Errors} from "../../Errors.sol";

//* Reserved for Richard review, to be deleted
// This is not in V2 scope?

/**
 * ReceivableCredit is a credit backed by receivables.
 */
contract CreditFacility is ReceivableCredit_old, ICreditFacility {
    function addReceivable(address borrower, uint256 receivableId) public virtual override {
        // todo onlyBorrower
        // todo makes sure the borrower owns the receivable
        bytes32 creditHash = _getCreditHash(borrower, receivableId);

        if (facilityConfig[creditHash].autoApproval) _approveReceivable(borrower, receivableId);

        receivableMap[creditHash][receivableId] = receivableId;
    }

    function declarePayment(
        address borrower,
        uint256 receivableId,
        uint256 amount
    ) external virtual override {
        ReceivableInfo memory receivableInfo = receivable.getReceivable(receivableId);
        if (
            receivableInfo.state == ReceivableState.Approved ||
            receivableInfo.state == ReceivableState.PartiallyPaid
        ) {
            receivableInfo.paidAmount += uint96(amount);
            if (receivableInfo.paidAmount >= receivableInfo.receivableAmount)
                receivableInfo.state = ReceivableState.Paid;
        } else revert Errors.todo();
    }
}
