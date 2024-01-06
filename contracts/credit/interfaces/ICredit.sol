// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;
import {CreditRecord, DueDetail} from "../CreditStructs.sol";

interface ICredit {
    function setCreditRecord(bytes32 creditHash, CreditRecord memory cr) external;

    function updateDueInfo(
        bytes32 creditHash,
        CreditRecord memory cr,
        DueDetail memory dd
    ) external;

    function getCreditRecord(bytes32 creditHash) external view returns (CreditRecord memory);

    function getDueDetail(bytes32 creditHash) external view returns (DueDetail memory);
}
