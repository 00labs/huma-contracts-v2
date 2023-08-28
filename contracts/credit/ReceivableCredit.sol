// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {CreditConfig, CreditRecord, ReceivableInfo, FacilityConfig, ReceivableState} from "./CreditStructs.sol";
import {BaseCredit} from "./BaseCredit.sol";
import {IReceivableCredit} from "./interfaces/IReceivableCredit.sol";
import {Receivable} from "./Receivable.sol";
import {Errors} from "../Errors.sol";

/**
 * ReceivableCredit is a credit backed by receivables.
 */
contract ReceivableCredit is BaseCredit, IReceivableCredit {
    // the NFT contract address for the receivable.
    // todo set Receivable in initializer.
    Receivable receivable;

    // creditHash => (receivableId => receivableId)
    // map from creditHash to the list of receivables.
    // Used a map to store a list of receivables instead of an array for efficiency consideration.
    mapping(bytes32 => mapping(uint256 => uint256)) receivableMap;

    // creditHash => FacilityConfig, the facility config for the credit
    mapping(bytes32 => FacilityConfig) facilityConfig;

    function approveReceivable(address borrower, uint256 receivableId) public {
        onlyEAServiceAccount();
        _approveReceivable(borrower, receivableId);
    }

    function _approveReceivable(address borrower, uint256 receivableId) public {
        receivable.approveOrRejectReceivable(receivableId, true);
        bytes32 creditHash = _getCreditHash(borrower, receivableId);

        _creditRecordMap[creditHash].availableCredit +=
            receivable.getReceivable(receivableId).receivableAmount *
            facilityConfig[creditHash].advanceRateInBps;

        // todo emit event
    }

    function rejectReceivable(address borrower, uint256 receivableId) public {
        onlyEAServiceAccount();
        receivable.approveOrRejectReceivable(receivableId, false);
        // todo emit event
    }

    function drawdownWithReceivable(
        address borrower,
        address receivableAddress,
        uint256 receivableId,
        uint256 amount,
        ReceivableInfo memory receivableInfo
    ) external {
        if (receivableAddress != address(receivable)) revert Errors.todo();
        if (receivable.ownerOf(receivableId) != borrower) revert Errors.todo();
        if (receivable.getStatus(receivableId) != ReceivableState.Approved) revert Errors.todo();

        bytes32 creditHash = _getCreditHash(borrower, receivableId);
        CreditRecord memory cr = _getCreditRecord(creditHash);

        receivable.transferFrom(borrower, address(this), receivableId);
        _drawdown(creditHash, cr, amount);
        // todo emit evnet
    }

    function _getCreditHash(
        address borrower,
        uint256 receivableId
    ) internal view returns (bytes32 creditHash) {
        if (_getBorrowerRecord(msg.sender).borrowerLevelCredit)
            creditHash = getCreditHash(msg.sender);
        else creditHash = keccak256(abi.encode(borrower, address(receivable), receivableId));
    }
}
